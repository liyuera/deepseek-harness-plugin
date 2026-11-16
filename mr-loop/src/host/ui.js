/**
 * UI 只读聚合：`GET /mr-loop/ui/state?scope=session|all`。
 *
 * 数据来源两路，live 优先：
 *   - live：本进程里仍在跟踪的绑定（有 mr 快照，可算可合并判定）
 *   - ledger：磁盘上每个 MR 的账本（进程重启/已解绑后仍能展示历史）
 *
 * 只读、无副作用；不碰 token，不写账本。UI 是「观测面」，判定口径与 CLI 报告一致。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expandHome } from './ledger.js'
import { evaluateMergeable, reviewTodo, isDisposed } from './mergeable.js'

const MAX_TEXT = 400
const MAX_COMMENTS = 5

/** note 正文/评论一律压成单行并截断：第三方内容不能改写前端结构。 */
function text(value, limit = MAX_TEXT) {
  if (value === null || value === undefined) return undefined
  const collapsed = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
  if (collapsed === '') return undefined
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed
}

const sanitizeId = (value) => (typeof value === 'string' && value !== '' ? value : undefined)

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

const roundOf = (record) => {
  const rounds = Array.isArray(record?.rounds) ? record.rounds : []
  return rounds.length === 0 ? null : rounds[rounds.length - 1]
}

const previousRoundOf = (record) => {
  const rounds = Array.isArray(record?.rounds) ? record.rounds : []
  return rounds.length < 2 ? null : rounds[rounds.length - 2]
}

const findingsOf = (round) => {
  const blocking = Array.isArray(round?.review?.blocking) ? round.review.blocking : []
  const nonBlocking = Array.isArray(round?.review?.nonBlocking) ? round.review.nonBlocking : []
  return [...blocking, ...nonBlocking]
}

const kindOfDecision = (decision) => (isDisposed(decision) ? decision.kind : null)

/**
 * 问题状态：open / waived(含 skip/wontfix) / fixed。
 * fixed = 上一轮有、本轮没有（有前一轮可比时才判定，否则不猜）。
 */
function problemsOf(record) {
  const round = roundOf(record)
  const previous = previousRoundOf(record)
  const decisions = record?.decisions !== null && typeof record.decisions === 'object' ? record.decisions : {}
  const current = findingsOf(round)
  const previousFids = new Set(findingsOf(previous).map((item) => String(item?.fid ?? '').toUpperCase()))
  const currentFids = new Set(current.map((item) => String(item?.fid ?? '').toUpperCase()))

  const problems = current.map((item) => {
    const fid = sanitizeId(item?.fid) ?? '?'
    const decision = decisions[fid] ?? decisions[String(item?.fid ?? '')]
    const kind = kindOfDecision(decision)
    return {
      fid,
      level: text(item?.level, 40) ?? '',
      type: text(item?.gateCategory ?? item?.type, 60) ?? '',
      file: text(item?.file, 300),
      line: Number.isSafeInteger(item?.line) ? item.line : undefined,
      problem: text(item?.problem) ?? '',
      suggestion: text(item?.suggestion),
      snippet: text(item?.snippet ?? item?.sourceSnippet),
      status: kind === null ? 'open' : 'waived',
      instruction: kind === null ? undefined : {
        kind,
        reason: text(decision?.reason, 200),
        noteId: Number.isSafeInteger(decision?.noteId) ? decision.noteId : undefined,
      },
    }
  })

  // 上一轮存在、本轮消失的 FID 记 fixed（不重复计入当前问题）
  for (const item of findingsOf(previous)) {
    const fid = String(item?.fid ?? '')
    if (fid === '' || currentFids.has(fid.toUpperCase())) continue
    if (decisions[fid] !== undefined || decisions[fid.toUpperCase()] !== undefined) continue
    problems.push({
      fid,
      level: text(item?.level, 40) ?? '',
      type: text(item?.gateCategory ?? item?.type, 60) ?? '',
      file: text(item?.file, 300),
      problem: text(item?.problem) ?? '',
      suggestion: text(item?.suggestion),
      status: 'fixed',
      fixedAtRound: round?.n,
    })
  }
  void previousFids
  return problems
}

function resultOf(record, live) {
  const round = roundOf(record)
  const binding = record?.binding ?? {}
  const decisions = record?.decisions !== null && typeof record.decisions === 'object' ? record.decisions : {}
  const todo = reviewTodo(round, decisions)
  const mr = live?.mr
  const mergeability = mr === undefined ? null : evaluateMergeable({ mr, round, decisions })
  return {
    projectPath: binding.projectPath ?? '',
    iid: binding.iid ?? 0,
    webUrl: `https://${new URL(live?.config?.baseUrl ?? 'https://git.htwisdom.cn').host}/${binding.projectPath}/-/merge_requests/${binding.iid}`,
    sourceBranch: binding.sourceBranch ?? '',
    targetBranch: binding.targetBranch ?? '',
    state: mr?.state ?? 'unknown',
    sha: round?.sha ?? '',
    round: round?.n ?? 0,
    updatedAt: record?.updatedAt ?? binding.boundAt ?? null,
    live: live !== undefined,
    session: live === undefined ? undefined : {
      id: live.sessionId,
      title: undefined,
    },
    review: round?.review === null || round?.review === undefined ? null : {
      verdict: round.review.verdict,
      historicalUnresolved: round.review.historicalUnresolved,
      verifiedFixed: round.review.verifiedFixed,
      newThisRound: todo.fresh,
    },
    gates: {
      sensitive: round?.sensitive?.verdict ?? null,
      mandatory: round?.mandatory?.verdict ?? null,
    },
    merge: mergeability === null ? null : {
      mergeable: mergeability.mergeable === true,
      missing: mergeability.missing,
      pipeline: mr?.head_pipeline === null || mr?.head_pipeline === undefined
        ? null
        : { id: mr.head_pipeline.id, status: mr.head_pipeline.status },
    },
    problems: problemsOf(record),
    pending: todo.total,
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
      const byKey = new Map()
      for (const record of records) {
        const binding = record?.binding
        if (binding === undefined) continue
        byKey.set(`${binding.projectPath}#${binding.iid}`, record)
      }
      for (const [key, live] of liveByKey) {
        // live 的账本可能还没落盘（刚绑定）：用内存状态补一条。
        if (!byKey.has(key)) byKey.set(key, live.state)
      }

      const mrs = []
      for (const [key, record] of byKey) {
        const live = liveByKey.get(key)
        if (scope === 'session' && live !== undefined && sessionId !== undefined && live.sessionId !== sessionId) continue
        if (scope === 'session' && live === undefined) continue
        try {
          mrs.push(resultOf(record, live))
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
