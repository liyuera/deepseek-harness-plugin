/**
 * 绑定服务：唯一有状态的地方。纯判定（rounds / mergeable / report）都在别处，
 * 这里只做「取数 → 归并 → 落账本 → 出报告」的编排，错误一律 ServiceError(code)。
 */
import { parseMrUrl } from './url.js'
import { readRepoState } from './repo.js'
import { buildRound } from './rounds.js'
import { evaluateMergeable } from './mergeable.js'
import { renderReport } from './report.js'

export class ServiceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
  }
}

const sameProject = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()

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
 * @param {{ config: object, ledger: object, gitlab: object, repoState?: Function, now?: () => number }} deps
 */
export function createService({ config, ledger, gitlab, repoState = readRepoState, now = Date.now, onBound = undefined }) {
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

  /** 同一会话的绑定串行：并发 /mr 不能各自 load→save，否则会丢轮次、起两个 watcher。 */
  const bindLocks = new Map()

  function bind(args) {
    const sessionId = args?.sessionId
    const task = () => bindInner(args)
    const previous = bindLocks.get(sessionId) ?? Promise.resolve()
    const next = previous.then(task, task)
    bindLocks.set(sessionId, next.catch(() => {}))
    return next
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
    return {
      state,
      newRound,
      reviewArrived: newRound === false && beforeVerdict !== (state.round?.review?.verdict ?? null),
      // 评审 verdict 的变化也包含在内；watcher 先判 reviewArrived，不会重复唤醒。
      gatesChanged: beforeGates !== gatesKey(state.round),
      becameMergeable: beforeMergeable === false && state.mergeability.mergeable === true,
    }
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
      return { stopped: state !== undefined, forgotten: true }
    }
    bindings.delete(sessionId)
    if (state !== undefined) await persist(state).catch(() => {})
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

  function getState(sessionId) {
    return bindings.get(sessionId) ?? null
  }

  function dispose() {
    bindings.clear()
  }

  return { bind, status, review, applySnapshot, stop, resume, pause, getState, dispose, report, ledger }
}
