/**
 * 绑定服务：唯一有状态的地方。纯判定（rounds / mergeable / report）都在别处，
 * 这里只做「取数 → 归并 → 落账本 → 出报告」的编排，错误一律 ServiceError(code)。
 */
import { parseMrUrl } from './url.js'
import { readRepoState } from './repo.js'
import { buildRound } from './rounds.js'
import { evaluateMergeable, isDisposed, isDisposedFinding, directiveFor, decisionFor, reviewFindings } from './mergeable.js'
import { clipText, FID_RE, parseDirectives, REASON_LIMIT } from './parse-directives.js'
import { GitlabError } from './gitlab.js'
import { renderReport } from './report.js'

export class ServiceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
  }
}

const sameProject = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()

/** 写路径只接受这三种处置；与服务端解析 / 账本口径一致。 */
const WAIVER_KINDS = new Set(['waive', 'skip', 'wontfix'])

/** 这些失败「结果未知」：评论可能已经创建，只能按 body 从 notes 里找回，不能直接重发（I1）。 */
const AMBIGUOUS_WRITE_CODES = new Set(['timeout', 'network', 'bad-response'])

/** 写路径错误的静态中文文案：非 GitlabError（上游原文不可信）一律用它，不回显 error.message（M6）。 */
const STATIC_WRITE_MESSAGES = Object.freeze({
  'no-token': '未配置 GitLab token',
  unauthorized: 'GitLab 鉴权失败，请检查 token',
  'permission-denied': 'GitLab 拒绝发评论：token 缺少 api 写权限',
  'not-found': 'GitLab 项目或 MR 不存在',
  'rate-limited': 'GitLab 请求过于频繁，请稍后重试',
  conflict: 'GitLab 请求冲突，资源状态已变化',
  network: '无法连接 GitLab 或服务暂时不可用',
  timeout: 'GitLab 请求超时',
  'bad-response': 'GitLab 响应结构异常',
  internal: '发评论失败',
})

/**
 * 发评论的 GitLab 错误码 → 工具面错误码。读路径的 403 是 `forbidden`（可能只是仓库不可见），
 * 写路径的 403 在 gitlab.postNote 里已映射成更具体的 `permission-denied`（缺 api 写权限）。
 */
const WRITE_ERROR_CODES = Object.freeze({
  'no-token': 'no-token',
  unauthorized: 'unauthorized',
  forbidden: 'permission-denied',
  'permission-denied': 'permission-denied',
  'not-found': 'not-found',
  'rate-limited': 'rate-limited',
  conflict: 'conflict',
  network: 'network',
  timeout: 'timeout',
  'bad-response': 'bad-response',
})

// 集合键：排序 + 去重，顺序与重复项都不影响「阻塞集合是否相同」的判定。
const blockingKey = (round) => [...new Set((round?.review?.blocking ?? []).map((item) => item?.fid))].sort().join(',')

/** 三套门禁的结论元组：评审先到、门禁后翻面的同 sha 场景靠它触发唤醒（设计 §5.4）。 */
const gatesKey = (round) => [
  round?.review?.verdict ?? 'none',
  round?.sensitive?.verdict ?? 'none',
  round?.mandatory?.verdict ?? 'none',
].join('|')

/** 同一 FID 的复验次数比上一轮上升（且已到触发门槛 2）才算「复验未收敛」。 */
function reverifyIncreased(previousRound, round) {
  const before = new Map((previousRound?.review?.blocking ?? []).map((item) => [item?.fid, item?.reverifyCount ?? 0]))
  return (round?.review?.blocking ?? []).some((item) => {
    const previous = before.get(item?.fid)
    const current = item?.reverifyCount ?? 0
    return previous !== undefined && current > previous && current >= 2
  })
}

/**
 * @param {{ config: object, ledger: object, gitlab: object, repoState?: Function, now?: () => number,
 *   onBound?: Function, findings?: { record: Function }, logger?: { warn?: Function } }} deps
 */
export function createService({ config, ledger, gitlab, repoState = readRepoState, now = Date.now, onBound = undefined, findings = undefined, logger = undefined }) {
  /** @type {Map<string, object>} sessionId → state */
  const bindings = new Map()

  function requireState(sessionId) {
    const state = bindings.get(sessionId)
    if (state === undefined) throw new ServiceError('not-bound', '当前会话还没有绑定 MR，先 /mr <链接>')
    return state
  }

  function report(state) {
    return renderReport({
      binding: state.binding,
      mr: state.mr,
      round: state.round,
      decisions: state.decisions,
      mergeability: state.mergeability,
      paused: state.paused,
      now: now(),
    })
  }

  /**
   * T4：findings 落盘是旁路记录（只记录、不参与判定）。
   * fire-and-forget：同步抛错与 rejected Promise 都只 log warn，绝不打断绑定 / 监视 / 回帖。
   */
  function record(state) {
    if (findings === undefined || findings === null) return
    const failed = (error) => logger?.warn?.(`[mr-loop] findings 写入失败：${error?.message ?? error}`)
    try {
      const pending = findings.record(state)
      if (pending !== null && typeof pending === 'object' && typeof pending.catch === 'function') pending.catch(failed)
    } catch (error) {
      failed(error)
    }
  }

  async function persist(state, extra = {}) {
    try {
      await ledger.save({
        version: 1,
        binding: state.binding,
        rounds: state.rounds,
        decisions: state.decisions,
        mergeableAt: state.mergeableAt ?? null,
        terminal: state.terminal ?? null,
        paused: state.paused,
        updatedAt: new Date(now()).toISOString(),
        ...extra,
      })
    } catch {
      // 原生 fs 错误不交给调用方：账本写不进去是「存储失败」，不是未知崩溃。
      throw new ServiceError('storage-failed', '账本写入失败，检查 ~/.dsh/mr-loop 的磁盘权限')
    }
  }

  /**
   * 同一会话的写操作串行：并发 /mr 不能各自 load→save，否则会丢轮次、起两个 watcher；
   * 并发 mr_waive post 也不能各发一条评论（后一次命中幂等分支即可）。
   */
  const sessionLocks = new Map()

  function serialize(sessionId, task) {
    const previous = sessionLocks.get(sessionId) ?? Promise.resolve()
    const next = previous.then(task, task)
    sessionLocks.set(sessionId, next.catch(() => {}))
    return next
  }

  function bind(args) {
    return serialize(args?.sessionId, () => bindInner(args))
  }

  async function bindInner({ sessionId, url, repoRoot }) {
    const parsed = parseMrUrl(url, config.baseUrl)
    if (parsed === null) throw new ServiceError('invalid-url', `MR 地址不属于 ${config.baseUrl} 或格式不对`)

    const mr = await gitlab.getMergeRequest({ project: parsed.project, iid: parsed.iid })
    if (mr.state !== 'opened') throw new ServiceError('mr-not-open', `MR 状态是 ${mr.state}`)

    let repo
    try {
      repo = await repoState({ cwd: repoRoot })
    } catch {
      throw new ServiceError('repo-mismatch', '当前目录不是可用的 git 仓库（需要可读的 origin）')
    }
    const expectedHost = new URL(config.baseUrl).hostname.toLowerCase()
    if (repo.host !== expectedHost || !sameProject(repo.projectPath, parsed.project)) {
      throw new ServiceError('repo-mismatch', `当前仓库是 ${repo.host}/${repo.projectPath}，MR 属于 ${expectedHost}/${parsed.project}`)
    }

    const notes = await gitlab.listNotes({ project: parsed.project, iid: parsed.iid })
    const observedAt = now()
    const previous = await ledger.load({ projectPath: parsed.project, iid: parsed.iid })
    // 轮次 = 一个 head sha 上的「评审 → 处置」周期：同 sha 的重绑复用轮次，sha 变化才新增。
    // 新增时用「已有最大轮次 + 1」而不是数组长度：账本裁剪后长度会回退，轮次号不能重复。
    const previousRounds = Array.isArray(previous?.rounds) ? previous.rounds : []
    const shaKnown = typeof mr.sha === 'string' && mr.sha !== ''
    // 先收敛账本尾部连续同 sha 的段，再判定复用 / 新增：旧版本可能堆了
    // [1(S),2(S),3(S),4(S)]，无论 head 是否已前进，都不能把虚高的 n 带进后续轮次。
    let rounds = previousRounds
    let baselineObservedAt = observedAt
    const tailSha = previousRounds[previousRounds.length - 1]?.sha
    if (shaKnown && typeof tailSha === 'string' && tailSha !== '') {
      let segmentStart = previousRounds.length - 1
      while (segmentStart > 0 && previousRounds[segmentStart - 1]?.sha === tailSha) segmentStart -= 1
      const segment = previousRounds.slice(segmentStart)
      // 锚条缺 observedAt 时，基线取段内最早的有效时间；全无才退回本次观测时间。
      const observedTimes = segment.map((item) => item?.observedAt).filter((value) => Number.isFinite(value))
      if (observedTimes.length > 0) baselineObservedAt = Math.min(...observedTimes)
      // 段长 > 1 才收敛；只保留 n 最小的合法条目，坏 n / 非正整数不参与编号。
      const valid = segment.filter((item) => Number.isSafeInteger(item?.n) && item.n > 0)
      if (segment.length > 1 && valid.length > 0) {
        const anchor = valid.reduce((min, item) => (item.n < min.n ? item : min))
        rounds = [...previousRounds.slice(0, segmentStart), anchor]
      }
    }
    const lastRound = rounds[rounds.length - 1]
    // sha 缺失（undefined / 空串）不能算「同 sha」；n 必须是正整数，否则 0 / 负数
    // 会复用出「第 0 轮」或倒序轮次。
    const reuse = shaKnown && Number.isSafeInteger(lastRound?.n) && lastRound.n > 0 && lastRound.sha === mr.sha
    let round
    let nextRounds
    if (reuse) {
      round = { ...buildRound({ mr, notes, cfg: config, observedAt: baselineObservedAt }), n: lastRound.n }
      nextRounds = [...rounds.slice(0, -1), round]
    } else {
      const n = rounds.reduce((max, item) => (Number.isSafeInteger(item?.n) && item.n > max ? item.n : max), 0) + 1
      round = { ...buildRound({ mr, notes, cfg: config, observedAt }), n }
      nextRounds = [...rounds, round]
    }

    const state = {
      sessionId,
      binding: {
        projectPath: parsed.project,
        iid: parsed.iid,
        repoRoot: repo.root,
        sourceBranch: mr.source_branch,
        targetBranch: mr.target_branch,
        boundAt: new Date(observedAt).toISOString(),
      },
      mr,
      round,
      rounds: nextRounds.slice(-config.ledgerKeepRounds),
      // mergeableAt 是 §5.5 的记录：同 sha 重绑继承；新轮次不继承上一轮的收尾时间。
      // 只继承字符串（null 表示尚未可合并），否则会挡住 applySnapshot 后续写入时间戳。
      mergeableAt: reuse && typeof previous?.mergeableAt === 'string' ? previous.mergeableAt : undefined,
      decisions: previous?.decisions !== null && typeof previous?.decisions === 'object' ? previous.decisions : {},
      mergeability: null,
      paused: null,
      notesCount: mr.user_notes_count ?? null,
      pipelineStatus: mr.head_pipeline?.status ?? null,
      startedAt: observedAt,
      lastProgressAt: observedAt,
      stallStreak: 0,
      reverifyStreak: 0,
      stallKey: blockingKey(round),
    }
    state.mergeability = evaluateMergeable({ mr, round, decisions: state.decisions })
    // 先落盘再登记：写失败时不留一个「半绑定」的会话状态。
    await persist(state)
    bindings.set(sessionId, state)
    record(state)

    const warnings = repo.branch !== mr.source_branch
      ? [{ code: 'branch-mismatch', message: `当前分支是 ${repo.branch}，MR 源分支是 ${mr.source_branch}` }]
      : []
    try {
      // watcher 启动是异步的：同步 catch 兜不住 rejected promise，必须显式吞掉。
      Promise.resolve(onBound?.({ sessionId, binding: state.binding })).catch(() => {})
    } catch {
      /* 同步抛错同样不影响绑定本身 */
    }
    return { report: report(state), warnings }
  }

  async function status({ sessionId }) {
    const state = requireState(sessionId)
    const mr = await gitlab.getMergeRequest({ project: state.binding.projectPath, iid: state.binding.iid })
    const notes = await gitlab.listNotes({ project: state.binding.projectPath, iid: state.binding.iid })
    const result = applySnapshot({ sessionId, mr, notes })
    return { report: report(result.state), state: result.state }
  }

  function review({ sessionId }) {
    const state = requireState(sessionId)
    return { round: state.round, decisions: state.decisions }
  }

  /**
   * 把一次外部快照并入状态；S2 的 watcher 每 tick 调它，S1 的 status 也走它。
   * 新 sha = 新一轮：轮次 +1、重置 await / 停顿计数；同 sha 只刷新解析结果。
   */
  function applySnapshot({ sessionId, mr, notes }) {
    const state = requireState(sessionId)
    const beforeMergeable = state.mergeability?.mergeable === true
    const beforeVerdict = state.round?.review?.verdict ?? null
    const beforeGates = gatesKey(state.round)
    let newRound = false

    if (mr.sha !== state.round?.sha) {
      newRound = true
      const previousRound = state.round
      const observedAt = now()
      const round = { ...buildRound({ mr, notes, cfg: config, observedAt }), n: (state.round?.n ?? 0) + 1 }
      // 守卫计数按「轮」推进：只有新 sha 开新一轮时才比较上一轮。
      // 同 sha 的快照（watcher 每 tick、/mr status）不碰 streak / stallKey。
      const key = blockingKey(round)
      state.stallStreak = key !== '' && key === state.stallKey ? state.stallStreak + 1 : 0
      state.stallKey = key
      state.reverifyStreak = reverifyIncreased(previousRound, round) ? state.reverifyStreak + 1 : 0
      state.round = round
      state.rounds = [...state.rounds, round].slice(-config.ledgerKeepRounds)
      state.lastProgressAt = observedAt
    } else if (Array.isArray(notes)) {
      state.round = { ...buildRound({ mr, notes, cfg: config, observedAt: state.round.observedAt }), n: state.round.n }
      state.rounds = [...state.rounds.slice(0, -1), state.round]
    }

    state.mr = mr
    state.notesCount = mr.user_notes_count ?? state.notesCount
    state.pipelineStatus = mr.head_pipeline?.status ?? null
    state.mergeability = evaluateMergeable({ mr, round: state.round, decisions: state.decisions })

    if (state.mergeability.mergeable && state.mergeableAt === undefined) state.mergeableAt = new Date(now()).toISOString()

    void persist(state).catch(() => {})
    record(state)
    return {
      state,
      newRound,
      reviewArrived: newRound === false && beforeVerdict !== (state.round?.review?.verdict ?? null),
      // 评审 verdict 的变化也包含在内；watcher 先判 reviewArrived，不会重复唤醒。
      gatesChanged: beforeGates !== gatesKey(state.round),
      becameMergeable: beforeMergeable === false && state.mergeability.mergeable === true,
    }
  }

  /**
   * 回收会话锁：只有在「等完当前链后 map 里仍是同一条链」时才删——避免把别人刚排上的
   * 新写操作从串行队列里摘掉（M7）。
   */
  async function releaseSessionLock(sessionId) {
    const pending = sessionLocks.get(sessionId)
    if (pending === undefined) return
    await pending.catch(() => {})
    if (sessionLocks.get(sessionId) === pending) sessionLocks.delete(sessionId)
  }

  /**
   * 会话销毁（index.js 的 session/disposed）用：只释放内存里的绑定 / 草稿 / 会话锁，
   * **不 persist、不 forget**——账本保留，稍后重开会话仍可 /mr resume；也不让已关闭会话
   * 永久占住同一 MR 的写路径（I-1）。
   */
  function release({ sessionId }) {
    const existed = bindings.has(sessionId)
    bindings.delete(sessionId)
    drafts.delete(sessionId)
    sessionLocks.delete(sessionId)
    return { released: existed }
  }

  async function stop({ sessionId, forget = false }) {
    const state = bindings.get(sessionId)
    if (forget) {
      if (state !== undefined) {
        try {
          await ledger.forget({ projectPath: state.binding.projectPath, iid: state.binding.iid })
        } catch {
          // 删除失败就别先把状态丢掉：调用方拿到 storage-failed，可以重试。
          throw new ServiceError('storage-failed', '账本删除失败，检查 ~/.dsh/mr-loop 的磁盘权限')
        }
      }
      bindings.delete(sessionId)
      drafts.delete(sessionId)
      await releaseSessionLock(sessionId)
      return { stopped: state !== undefined, forgotten: true }
    }
    bindings.delete(sessionId)
    if (state !== undefined) await persist(state).catch(() => {})
    drafts.delete(sessionId)
    await releaseSessionLock(sessionId)
    return { stopped: state !== undefined, forgotten: false }
  }

  function pause({ sessionId, reason }) {
    const state = requireState(sessionId)
    state.paused = { reason, at: new Date(now()).toISOString() }
    void persist(state).catch(() => {})
    return state
  }

  async function resume({ sessionId }) {
    const state = requireState(sessionId)
    const observedAt = now()
    // 恢复必须连守卫计数一起清：否则停表前的 streak 会让下一个 tick 立刻再次暂停。
    state.paused = null
    state.startedAt = observedAt
    state.lastProgressAt = observedAt
    state.stallStreak = 0
    state.reverifyStreak = 0
    state.stallKey = blockingKey(state.round)
    // 先改内存再落盘：写失败对外是 storage-failed，但内存里不能留下「仍在暂停」的假象。
    await persist(state)
    return state
  }

  // ---------------------------------------------------------------------------
  // T2 写路径：豁免草稿（不落账本 / 不发评论，只记会话内确认目标）与回帖（唯一写 GitLab 的路径）
  // ---------------------------------------------------------------------------

  /**
   * 会话内的豁免草稿：`Map<sessionId, Map<fidLower, draft>>`，只进内存、不入账本。
   * 用 per-FID 多槽而不是单槽：并发处置多条 finding 时，后出的草稿不会吃掉前一条（M-1）；
   * post 只消费自己那一条草稿，且必须与它逐字段一致（C1）。
   */
  const drafts = new Map()

  /** 单行化 + 截断到解析器上限，保证回帖能被自己的读路径原样读回（不会被二次裁剪出差异）。 */
  const waiverReason = (value) => clipText(value, REASON_LIMIT)

  const mrLabelOf = (state) => `MR !${state.binding.iid} · ${state.binding.projectPath}`

  const sameBindingTarget = (left, right) => typeof left?.binding?.projectPath === 'string'
    && sameProject(left.binding.projectPath, right?.binding?.projectPath)
    && left.binding.iid === right?.binding?.iid

  /** 只做 kind / reason / FID 格式校验，不查当前轮：草稿与回帖共用。 */
  function waiverInput({ fid, kind, reason }) {
    const normalizedKind = kind === undefined ? 'waive' : kind
    if (typeof normalizedKind !== 'string' || WAIVER_KINDS.has(normalizedKind) === false) {
      throw new ServiceError('invalid-kind', 'kind 只能是 waive / skip / wontfix')
    }
    const normalizedReason = waiverReason(reason)
    if (normalizedReason === '') throw new ServiceError('invalid-reason', 'reason 必须是非空的单行文本')
    const wanted = typeof fid === 'string' ? fid.trim() : ''
    // 回帖 body 要能被自己的解析器读回，FID 必须先符合解析器的字符 / 长度约束。
    if (wanted === '' || FID_RE.test(wanted) === false) {
      throw new ServiceError('unknown-fid', 'FID 不属于当前轮评审的未处置问题（格式或轮次不对）')
    }
    return { kind: normalizedKind, reason: normalizedReason, fid: wanted }
  }

  /** 在当前轮 finding 里按大小写不敏感找 FID，返回评审原文大小写的 FID。 */
  function waiverFindingFid(state, fid) {
    const key = fid.toLowerCase()
    const finding = reviewFindings(state.round?.review).find((item) => String(item?.fid ?? '').trim().toLowerCase() === key) ?? null
    const canonicalFid = String(finding?.fid ?? '').trim()
    if (finding === null || canonicalFid === '') throw new ServiceError('unknown-fid', 'FID 不属于当前轮评审的未处置问题')
    return canonicalFid
  }

  /**
   * M1 round-trip：生成 body 后用真实解析器读一遍，必须恰好 1 条且 fid / kind / reason 全等。
   * 挡住 reason 里塞 HTML 注释 / 隐藏统计块标记，导致「发出去的指令读回来失真」。
   */
  function waiverBodyOf({ kind, fid, reason }) {
    const body = `#ai-${kind} ${fid} reason=${reason}`
    const parsed = parseDirectives([{ id: 0, system: false, body }])
    const back = parsed.directives[0]
    if (parsed.directives.length !== 1 || back.fid !== fid || back.kind !== kind || back.reason !== reason) {
      throw new ServiceError('invalid-reason', 'reason 含会被指令解析器丢弃 / 改写的内容（如 <!-- -->、隐藏块标记），请换一种写法')
    }
    return body
  }

  /**
   * 幂等命中：当前轮 MR 指令里已有同 FID 同 kind，或本会话已回帖过同 kind 的 decisions。
   * 命中返回 noteId，调用方直接回 `{ posted: false, existing: true }`，绝不重复发评论。
   */
  function existingWaiver(state, { fid, kind }) {
    const directive = directiveFor(state.round, fid)
    if (directive !== null && directive.kind === kind) {
      return { noteId: typeof directive.noteId === 'number' ? directive.noteId : null }
    }
    const decision = decisionFor(state.decisions, fid)
    if (isDisposed(decision) && decision.kind === kind) {
      return { noteId: Number.isSafeInteger(decision.noteId) ? decision.noteId : null }
    }
    return null
  }

  /**
   * 只生成草稿：不写账本、不改 decisions、不碰 GitLab；但把「确认目标」记进会话内存，
   * postWaiver 必须逐字段匹配它才发（防确认后换绑 / 换 sha 把评论发到错误 MR，C1）。
   */
  function waiverDraft({ sessionId, fid, kind, reason }) {
    const state = requireState(sessionId)
    const input = waiverInput({ fid, kind, reason })
    const canonicalFid = waiverFindingFid(state, input.fid)
    if (isDisposedFinding(state.round, state.decisions, canonicalFid)) {
      throw new ServiceError('already-disposed', '该 FID 已有处置（MR 指令或已回帖的 decisions），不再生成草稿')
    }
    const body = waiverBodyOf({ ...input, fid: canonicalFid })
    let sessionDrafts = drafts.get(sessionId)
    if (sessionDrafts === undefined) {
      sessionDrafts = new Map()
      drafts.set(sessionId, sessionDrafts)
    }
    // 同一 FID 重新出草稿 = 覆盖该 FID 的旧草稿（用户「自定义」后重确认）；其它 FID 的草稿保留。
    sessionDrafts.set(canonicalFid.toLowerCase(), {
      projectPath: state.binding.projectPath,
      iid: state.binding.iid,
      sha: String(state.round?.sha ?? state.mr?.sha ?? ''),
      fid: canonicalFid,
      kind: input.kind,
      reason: input.reason,
      at: new Date(now()).toISOString(),
    })
    return { body, fid: canonicalFid, kind: input.kind, reason: input.reason, mrLabel: mrLabelOf(state) }
  }

  /** GitLab 失败 → 稳定的 ServiceError；非 GitlabError（原文不可信）用静态文案，不回显上游原文（M6）。 */
  function writeFailure(error) {
    const rawCode = typeof error?.code === 'string' ? error.code : ''
    const code = WRITE_ERROR_CODES[rawCode] ?? 'internal'
    const message = error instanceof GitlabError
      ? error.message
      : STATIC_WRITE_MESSAGES[code] ?? STATIC_WRITE_MESSAGES.internal
    return new ServiceError(code, message)
  }

  /** 回帖地址：优先 MR 的 web_url，缺失时按 baseUrl + 项目路径拼；统一带 #note_<id>。 */
  function noteUrl(state, noteId) {
    const { projectPath, iid } = state.binding
    const webUrl = state.mr?.web_url
    const base = typeof webUrl === 'string' && /^https?:\/\//.test(webUrl)
      ? webUrl.replace(/#.*$/, '').replace(/\/+$/, '')
      : `${new URL(config.baseUrl).origin}/${projectPath}/-/merge_requests/${iid}`
    return `${base}#note_${noteId}`
  }

  /**
   * I1：timeout / network / bad-response 时评论可能已创建。按「body 全等 + created_at >= 草稿时间」
   * 在 notes 里找回；找不到返回 null，由调用方抛原始失败。listNotes 自己失败也按找不到处理。
   */
  async function recoverPostedNote(state, body, notBefore) {
    let notes
    try {
      notes = await gitlab.listNotes({ project: state.binding.projectPath, iid: state.binding.iid })
    } catch {
      return null
    }
    // M-3：notes.created_at 可能因服务端 / 本机时钟偏移略早于草稿时间，扣掉一个请求超时余量，
    // 否则「评论其实已创建」会被漏认领，下一次重试就会重复发。
    const since = Date.parse(notBefore) - config.requestTimeoutMs
    if (!Number.isFinite(since)) return null
    const found = (Array.isArray(notes) ? notes : []).find((note) => {
      if (note === null || typeof note !== 'object' || note.system === true) return false
      if (note.body !== body) return false
      const createdAt = Date.parse(note.created_at ?? '')
      return Number.isFinite(createdAt) && createdAt >= since
    })
    return found ?? null
  }

  /**
   * 回帖成功后统一落 decisions 并清掉草稿。M2：persist 失败不报 storage-failed（评论确实发出去了），
   * 降级成 `persisted:false + warning`，同时内存里保留 decision，重试会命中幂等而不是重复发。
   */
  async function recordPostedWaiver(sessionId, state, input, note, { body, recovered = false }) {
    state.decisions[input.fid] = {
      kind: input.kind,
      reason: input.reason,
      noteId: note.id,
      at: new Date(now()).toISOString(),
      source: 'comment',
    }
    const sessionDrafts = drafts.get(sessionId)
    if (sessionDrafts !== undefined) {
      sessionDrafts.delete(input.fid.toLowerCase())
      if (sessionDrafts.size === 0) drafts.delete(sessionId)
    }
    const result = { posted: true, noteId: note.id, url: noteUrl(state, note.id), body }
    if (recovered) result.recovered = true
    try {
      await persist(state)
    } catch (error) {
      result.persisted = false
      result.warning = typeof error?.message === 'string' && error.message !== '' ? error.message : '账本写入失败'
    }
    record(state)
    return result
  }

  async function postWaiverInner({ sessionId, fid, kind, reason }) {
    const state = requireState(sessionId)
    const input = waiverInput({ fid, kind, reason })
    // 幂等先于其它校验：重复 post（含并发第二次）不该报错，也不该再发。
    const existing = existingWaiver(state, input)
    if (existing !== null) return { posted: false, noteId: existing.noteId, existing: true }
    const canonicalFid = waiverFindingFid(state, input.fid)
    const canonical = { ...input, fid: canonicalFid }
    if (isDisposedFinding(state.round, state.decisions, canonicalFid)) {
      throw new ServiceError('already-disposed', '该 FID 已用其它方式处置，不再重复回帖')
    }
    // I2：同一 MR 已被其它 live 会话绑定 → 拒绝写，避免两边 decisions / 账本互相覆盖。
    const other = listStates().find((item) => item.sessionId !== sessionId && sameBindingTarget(item, state))
    if (other !== undefined) {
      throw new ServiceError('bound-elsewhere', `同一 MR 已被其它会话绑定（${other.sessionId ?? '未知'}），先在那条会话 mr_stop 再回帖；若是已关闭会话，重启应用 / 重载插件即可清除`)
    }
    // C1：必须与上次确认的草稿逐字段一致。M-1：按 FID 取草稿，多槽互不覆盖。
    const sessionDrafts = drafts.get(sessionId)
    const draft = sessionDrafts?.get(canonicalFid.toLowerCase())
    if (draft === undefined) {
      throw new ServiceError('draft-required', '先调用 mr_waive 出草稿并由用户确认，再 post:true 回帖')
    }
    const currentSha = String(state.round?.sha ?? state.mr?.sha ?? '')
    const targetChanged = draft.projectPath !== state.binding.projectPath
      || draft.iid !== state.binding.iid
      || String(draft.sha) !== currentSha
    if (targetChanged) {
      throw new ServiceError('stale-round', '草稿的目标 MR / 轮次已变化，请重新出草稿并确认')
    }
    if (draft.kind !== canonical.kind || draft.reason !== canonical.reason) {
      // 同一 FID 已用新参数重新确认过：旧参数不能再发，但这不是换绑 / 换轮。
      throw new ServiceError('draft-superseded', '该 FID 的草稿已被更新的确认内容取代，请按最新草稿 post')
    }
    const body = waiverBodyOf(canonical)
    let note
    try {
      note = await gitlab.postNote({ project: state.binding.projectPath, iid: state.binding.iid, body })
    } catch (error) {
      const failure = writeFailure(error)
      if (AMBIGUOUS_WRITE_CODES.has(failure.code)) {
        const recovered = await recoverPostedNote(state, body, draft.at)
        if (recovered !== null) {
          return recordPostedWaiver(sessionId, state, canonical, recovered, { body, recovered: true })
        }
      }
      // 失败时内存 / 账本都保持原样：没发出去的评论不能算处置；草稿保留以便重试。
      throw failure
    }
    return recordPostedWaiver(sessionId, state, canonical, note, { body })
  }

  /** 回帖必须经用户确认由主代理显式调用（post:true），不会自动发。 */
  function postWaiver(args) {
    return serialize(args?.sessionId, () => postWaiverInner(args ?? {}))
  }

  /**
   * I1：merged / closed 终态落账本。终态是永久的：必须 await persist，UI 与下次启动才能从
   * 账本看到「已合并」；同时更新内存 state.mr 供 live 看板读取。findings 仍走旁路 record。
   */
  async function markTerminal({ sessionId, mr }) {
    const state = requireState(sessionId)
    state.mr = mr
    state.terminal = typeof mr?.state === 'string' && mr.state !== '' ? mr.state : null
    await persist(state)
    record(state)
    return state
  }

  function getState(sessionId) {
    return bindings.get(sessionId) ?? null
  }

  /** UI 只读聚合用：当前进程里所有仍在跟踪的绑定（返回值只读，不要改它）。 */
  function listStates() {
    return [...bindings.values()]
  }

  function dispose() {
    bindings.clear()
    drafts.clear()
    sessionLocks.clear()
  }

  return { bind, status, review, applySnapshot, stop, resume, pause, getState, listStates, dispose, report, ledger, waiverDraft, postWaiver, release, markTerminal }
}
