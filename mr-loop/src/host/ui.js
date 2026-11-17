/**
 * UI 只读聚合：`GET /mr-loop/ui/state?scope=session|all`。
 *
 * 数据来源两路，live 优先：
 *   - live：本进程里仍在跟踪的绑定（有 mr 快照，可算可合并判定）
 *   - ledger：磁盘上每个 MR 的账本（进程重启/已解绑后仍能展示历史）
 *
 * 只读、无副作用；不碰 token，不写账本。UI 是「观测面」，判定口径与 CLI 报告一致；
 * 问题状态与 findings 落盘共用 findings.js 的 `collectFindings`，不在这里另写一套判定。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expandHome } from './ledger.js'
import { evaluateMergeable, reviewTodo } from './mergeable.js'
import { collectFindingsIndex, settledRoundIndex } from './findings.js'
import { normalizeRounds } from './rounds.js'

/**
 * 账本目录里每个文件即一个 MR。读坏的文件按「没有」处理（与 ledger.load 同口径）。
 */
async function readLedgerFiles(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const records = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await readFile(join(dir, name), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') records.push(parsed)
    } catch {
      /* 单个坏文件不影响其它 MR */
    }
  }
  return records
}

const roundsOf = (record) => (Array.isArray(record?.rounds) ? record.rounds : [])

/**
 * 唯一问题索引（findings.js 的 collectFindingsIndex）→ 面板展示形状：
 * 面板只有 open / waived / fixed 三态，skip / wontfix 都显示为 waived；
 * 真正的处置方式保留在 instruction.kind。
 *
 * `firstRound` / `rounds` / `count`：这个问题首次出现在第几轮、都在哪几轮出现过、一共出现几次。
 * 面板据此「只在首次出现的轮次里展示，并标出首见轮次与次数」。
 *
 * `unverified`：当前轮评审还没落地，所以「未处理」只代表最近一次已落地评审的结论，
 * 不能断言现在还没修——面板据此显示成「待复验」。
 */
function uiProblemOf(finding, unverified = false) {
  const status = finding.status === 'open' || finding.status === 'fixed' ? finding.status : 'waived'
  const problem = {
    fid: finding.fid,
    level: finding.level,
    type: finding.gateCategory ?? finding.type ?? '',
    file: finding.file,
    line: finding.line,
    problem: finding.problem,
    suggestion: finding.suggestion,
    snippet: finding.snippet,
    status,
    instruction: finding.instruction === null ? undefined : finding.instruction,
    firstRound: finding.firstRound,
    lastRound: finding.lastRound,
    rounds: finding.rounds,
    count: finding.count,
  }
  if (unverified === true && status === 'open') problem.unverified = true
  if (finding.fixedAtRound !== undefined) problem.fixedAtRound = finding.fixedAtRound
  return problem
}

/** 轮次时间戳是 ms 数（账本里存 observedAt），转 ISO 供前端展示；非法值给 null。 */
function isoOf(value) {
  const time = typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

/**
 * 单轮摘要（面板的轮次条 + 进入该轮的问题列表）。
 *
 * 轮次计数只看**首次出现**在那一轮的问题（`newCount`）；同一 FID 在后续轮次再被提到
 * 不再重复计数，只记 `repeatCount`（历史未收敛），面板轮次条上单独标一个 ↻ 数。
 * 这样「243 一共 6 个问题」在轮次条上的和就是 6，不会因为重复出现被放大成十几个。
 *
 * 「本轮修复的问题」不再进任何一轮的列表（用户口径）：问题只在首次出现的那一轮展示，
 * 修复状态挂在原条目上（✓ 第 N 轮已修），没有问题的轮次因此不会凭空多出一串已修项。
 */
function roundSummaryOf(round, index, { problems, repeats, unverified, current, comments }) {
  const n = Number.isSafeInteger(round?.n) ? round.n : index + 1
  const withComment = (finding) => {
    const problem = uiProblemOf(finding, unverified)
    const noteId = problem.instruction?.noteId
    const comment = noteId === undefined ? undefined : comments.get(noteId)
    if (comment !== undefined) problem.comment = comment
    return problem
  }
  return {
    n,
    sha: typeof round?.sha === 'string' ? round.sha : '',
    verdict: round?.review?.verdict ?? null,
    binding: round?.binding ?? null,
    at: isoOf(round?.observedAt),
    // 该轮评审一共报了几条：新出现的 + 历史未收敛（重复出现）。
    total: problems.length + repeats.length,
    newCount: problems.length,
    repeatCount: repeats.length,
    current,
    // 只在轮次条 tooltip / 轮次详情里用的摘要，不带问题正文。
    repeats: repeats.map((finding) => ({ fid: finding.fid, firstRound: finding.firstRound, count: finding.count })),
    problems: problems.map(withComment),
  }
}

/** 流水线摘要：head_pipeline 可能还停在上一笔提交，sha 一并给出供面板判断。 */
function pipelineOf(mr) {
  const pipeline = mr?.head_pipeline
  if (pipeline === null || pipeline === undefined) return null
  return {
    id: pipeline.id,
    status: pipeline.status,
    sha: typeof pipeline.sha === 'string' ? pipeline.sha : null,
  }
}

/** MR 地址：用配置的 baseUrl（含可能的子路径）拼，不写死实例 host（M2）。 */
function webUrlOf(config, binding) {
  let base
  try {
    base = new URL(String(config?.baseUrl ?? ''))
  } catch {
    return ''
  }
  const basePath = base.pathname.replace(/\/+$/, '')
  const project = String(binding?.projectPath ?? '')
  const iid = binding?.iid ?? 0
  return `${base.origin}${basePath}/${project}/-/merge_requests/${iid}`
}

/**
 * 指令评论原文：directiveNotes 只有 noteId/body，作者与时间从 directives 里捞（同一 noteId）。
 * 跨全部轮次合并：唯一问题索引里的处置可能来自更晚的一轮（早期轮次找不到原文）。
 */
function commentsOf(rounds) {
  const meta = new Map()
  const map = new Map()
  for (const round of Array.isArray(rounds) ? rounds : []) {
    for (const directive of Array.isArray(round?.directives?.directives) ? round.directives.directives : []) {
      if (Number.isSafeInteger(directive?.noteId) && !meta.has(directive.noteId)) {
        meta.set(directive.noteId, { author: directive.author ?? null, createdAt: directive.createdAt ?? null })
      }
    }
  }
  for (const round of Array.isArray(rounds) ? rounds : []) {
    for (const note of Array.isArray(round?.directiveNotes) ? round.directiveNotes : []) {
      if (!Number.isSafeInteger(note?.noteId) || map.has(note.noteId)) continue
      const extra = meta.get(note.noteId) ?? { author: null, createdAt: null }
      map.set(note.noteId, {
        noteId: note.noteId,
        body: note.body ?? '',
        author: extra.author,
        createdAt: extra.createdAt,
      })
    }
  }
  return map
}

function resultOf(record, live, config) {
  const rawRounds = roundsOf(record)
  // 轮次条 / 问题归属只认「真实轮次」：push 了但没有流水线、也没有评审的那一轮会被去掉并重编号，
  // 所以「提交了但流水线没工作」不会让面板的轮次 +1（用户口径 0.3.0）。
  const rounds = normalizeRounds(rawRounds)
  // 判定口径仍用当前轮（原始最后一轮，可能是等待评审的伪轮次）；展示口径用最后一个真实轮次。
  const currentRound = rawRounds.length === 0 ? null : rawRounds[rawRounds.length - 1]
  const displayRound = rounds.length === 0 ? null : rounds[rounds.length - 1]
  // 当前轮评审还没落地时，「未处理」只代表最近一次落地评审的结论（面板显示「待复验」）。
  // 这一口径对所有视图一致（顶层列表与历史轮列表不会互相矛盾）。
  const unverified = settledRoundIndex(record) !== rawRounds.length - 1
  const binding = record?.binding ?? {}
  const decisions = record?.decisions !== null && typeof record.decisions === 'object' ? record.decisions : {}
  const todo = reviewTodo(currentRound, decisions)
  const currentReview = reviewTodo(displayRound, decisions)
  const mr = live?.state?.mr
  // M1：live 的 MR 快照必须与当前轮同 sha 才参与合并判定——不一致说明快照还没并进这一轮，
  // 拿它算会得到错配的「可合 / 差 N 项」。
  const roundSha = typeof currentRound?.sha === 'string' ? currentRound.sha : ''
  const mrSha = typeof mr?.sha === 'string' ? mr.sha : ''
  const mergeability = mr === undefined || roundSha === '' || mrSha !== roundSha
    ? null
    : evaluateMergeable({ mr, round: currentRound, decisions })
  // 终态（merged / closed）：账本 terminal 是永久的；live 时也可以从 MR 快照看出来。
  // 已经结束的 MR 不再算「差几项」——之前会把「MR 状态是 merged」当成缺口显示成「差 1 项」。
  const terminalState = typeof record?.terminal === 'string' && record.terminal !== ''
    ? record.terminal
    : (mr?.state === 'merged' || mr?.state === 'closed' ? mr.state : null)
  // 唯一问题索引：243 这类 MR 一共只有 6 个 FID，面板就只显示 6 条（重复出现只累加次数）。
  const indexFindings = collectFindingsIndex(record)
  const comments = commentsOf(rounds)
  const problems = indexFindings.map((finding) => {
    const problem = uiProblemOf(finding, unverified)
    const noteId = problem.instruction?.noteId
    const comment = noteId === undefined ? undefined : comments.get(noteId)
    if (comment !== undefined) problem.comment = comment
    return problem
  })
  const roundSummaries = rounds.map((round, index) => {
    const n = Number.isSafeInteger(round?.n) ? round.n : index + 1
    const first = indexFindings.filter((finding) => finding.firstRound === n)
    const repeats = indexFindings.filter((finding) => finding.firstRound !== n
      && Array.isArray(finding.rounds) && finding.rounds.includes(n))
    return roundSummaryOf(round, index, {
      problems: first,
      repeats,
      unverified,
      current: index === rounds.length - 1,
      comments,
    })
  })
  // 新提交已 push、本轮评审还没落地（含「没有流水线、评审不会自己来」）：面板给出等待提示。
  const waiting = terminalState === null && currentRound !== null
    && (currentRound.review === null || currentRound.review === undefined)
    ? { sha: typeof currentRound.sha === 'string' ? currentRound.sha : '', since: isoOf(currentRound.observedAt) }
    : null
  const countOfStatus = (status) => problems.filter((problem) => problem.status === status).length
  return {
    projectPath: binding.projectPath ?? '',
    iid: binding.iid ?? 0,
    webUrl: webUrlOf(config, binding),
    sourceBranch: binding.sourceBranch ?? '',
    targetBranch: binding.targetBranch ?? '',
    // I1：终态以账本记录为准（merged/closed 是永久的）；live 还没落账本时回落实时 mr。
    state: record?.terminal ?? mr?.state ?? 'unknown',
    // sha 给当前 head（新提交等待评审时也要看得到是哪一笔）。
    sha: mrSha !== '' ? mrSha : (typeof currentRound?.sha === 'string' ? currentRound.sha : ''),
    round: displayRound === null ? 0 : (Number.isSafeInteger(displayRound.n) ? displayRound.n : rounds.length),
    updatedAt: record?.updatedAt ?? binding.boundAt ?? null,
    live: live !== undefined,
    session: live === undefined ? undefined : {
      id: live.sessionId,
      title: undefined,
    },
    review: displayRound?.review === null || displayRound?.review === undefined ? null : {
      verdict: displayRound.review.verdict,
      historicalUnresolved: displayRound.review.historicalUnresolved,
      verifiedFixed: displayRound.review.verifiedFixed,
      newThisRound: currentReview.fresh,
    },
    gates: {
      sensitive: displayRound?.sensitive?.verdict ?? null,
      mandatory: displayRound?.mandatory?.verdict ?? null,
    },
    merge: terminalState !== null
      ? {
          mergeable: false,
          missing: [],
          // 终态单独标注：面板显示「已合并 / 已关闭」，不再显示「差 N 项」。
          terminal: terminalState,
          pipeline: pipelineOf(mr),
        }
      : mergeability === null
        ? null
        : {
            mergeable: mergeability.mergeable === true,
            missing: mergeability.missing,
            // sha 一并给出：head_pipeline 可能还停在上一笔提交（这笔 push 没触发流水线），
            // 面板据此提示「这笔提交还没有流水线」，而不是让用户以为评审是插件没解析出来。
            pipeline: pipelineOf(mr),
          },
    // 问题列表统一按「首次出现的轮次」归属；problemsRound 是默认视图锚定的那一轮。
    problemsRound: displayRound === null ? null : {
      n: Number.isSafeInteger(displayRound.n) ? displayRound.n : rounds.length,
      sha: typeof displayRound.sha === 'string' ? displayRound.sha : '',
      current: true,
    },
    waiting,
    // 唯一问题的状态汇总：面板标题「共 N 个问题 · 已修 X」直接用，不用前端再数一遍。
    summary: {
      total: problems.length,
      open: countOfStatus('open'),
      fixed: countOfStatus('fixed'),
      waived: countOfStatus('waived'),
    },
    // 轮次条：完整轮次（不截断），每轮只带「首次出现在该轮」的问题正文，
    // 重复出现的只给摘要（repeats），payload 不会随轮次重复膨胀。
    rounds: roundSummaries,
    // 问题唯一索引：每个 FID 只出现一次，带首见轮次 / 出现轮次 / 次数 / 修复轮次。
    problems,
    // 已结束的 MR 不再报「待处理」：评审问题已成历史，主代理不需要再动手。
    pending: terminalState !== null ? 0 : todo.total,
  }
}

/**
 * @param {{ config: { ledgerDir: string, baseUrl: string }, service: object, logger?: object }} deps
 */
export function createUiState({ config, service, logger = undefined }) {
  const dir = expandHome(config.ledgerDir)

  return {
    /**
     * @param {{ scope?: 'session'|'all', sessionId?: string }} query
     */
    async snapshot({ scope = 'all', sessionId = undefined } = {}) {
      const liveStates = typeof service.listStates === 'function' ? service.listStates() : []
      const liveByKey = new Map()
      for (const state of liveStates) {
        const binding = state?.binding
        if (binding === undefined) continue
        liveByKey.set(`${binding.projectPath}#${binding.iid}`, {
          state,
          sessionId: state.sessionId,
          config,
        })
      }

      const records = await readLedgerFiles(dir)
      const diskByKey = new Map()
      for (const record of records) {
        const binding = record?.binding
        if (binding === undefined) continue
        diskByKey.set(`${binding.projectPath}#${binding.iid}`, record)
      }
      // live 优先（注释与实现一致）：内存状态比 fire-and-forget 的账本更新；live state 不维护
      // updatedAt，回落磁盘记录，保证排序 / 展示时间仍有值。
      const byKey = new Map()
      for (const [key, live] of liveByKey) {
        const disk = diskByKey.get(key)
        byKey.set(key, { ...live.state, updatedAt: live.state.updatedAt ?? disk?.updatedAt })
      }
      for (const [key, record] of diskByKey) {
        if (!byKey.has(key)) byKey.set(key, record)
      }

      const mrs = []
      for (const [key, record] of byKey) {
        const live = liveByKey.get(key)
        if (scope === 'session' && live !== undefined && sessionId !== undefined && live.sessionId !== sessionId) continue
        if (scope === 'session' && live === undefined) continue
        try {
          mrs.push(resultOf(record, live, config))
        } catch (error) {
          logger?.warn?.(`[mr-loop] UI 聚合跳过 ${key}：${error.message}`)
        }
      }
      mrs.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      return {
        scope,
        updatedAt: new Date().toISOString(),
        mrs,
        counts: {
          total: mrs.length,
          pending: mrs.reduce((sum, mr) => sum + (mr.pending ?? 0), 0),
          mergeable: mrs.filter((mr) => mr.merge?.mergeable === true).length,
          merged: mrs.filter((mr) => mr.state === 'merged').length,
        },
      }
    },
  }
}

/**
 * 注册只读路由。路径刻意不带 `/api` 前缀：那个前缀归 client-connection 的 RPC 网关。
 * @param {{ ctx: object, ui: { snapshot: Function }, logger?: object }} deps
 */
export function registerUiRoute({ ctx, ui, logger = undefined }) {
  return ctx.inject(['webServer'], (scoped) => scoped.effect(() => scoped.webServer.register({
    kind: 'exact',
    path: '/mr-loop/ui/state',
    handler: async (request, res) => {
      const url = new URL(request.url ?? '/mr-loop/ui/state', 'http://localhost')
      const scope = url.searchParams.get('scope') === 'session' ? 'session' : 'all'
      const sessionId = url.searchParams.get('sessionId') ?? undefined
      try {
        const payload = await ui.snapshot({ scope, sessionId })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(payload))
      } catch (error) {
        logger?.warn?.(`[mr-loop] UI 状态失败：${error.message}`)
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'state-failed' }))
      }
    },
  }), 'mr-loop: ui route'))
}
