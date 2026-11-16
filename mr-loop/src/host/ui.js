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
import { collectFindings } from './findings.js'

const MAX_COMMENTS = 5

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

/**
 * 共享 findings 判定（findings.js）→ UI 展示形状：面板只有 open / waived / fixed 三态，
 * skip / wontfix 都显示为 waived；真正的处置方式保留在 instruction.kind。
 */
function uiProblemOf(finding) {
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
  }
  if (finding.fixedAtRound !== undefined) problem.fixedAtRound = finding.fixedAtRound
  return problem
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

/** 指令评论原文：directiveNotes 只有 noteId/body，作者与时间从 directives 里捞（同一 noteId）。 */
function commentMapOf(round) {
  const notes = Array.isArray(round?.directiveNotes) ? round.directiveNotes : []
  const directives = Array.isArray(round?.directives?.directives) ? round.directives.directives : []
  const meta = new Map()
  for (const directive of directives) {
    if (Number.isSafeInteger(directive?.noteId) && !meta.has(directive.noteId)) {
      meta.set(directive.noteId, { author: directive.author ?? null, createdAt: directive.createdAt ?? null })
    }
  }
  const map = new Map()
  for (const note of notes) {
    if (!Number.isSafeInteger(note?.noteId)) continue
    const extra = meta.get(note.noteId) ?? { author: null, createdAt: null }
    map.set(note.noteId, {
      noteId: note.noteId,
      body: note.body ?? '',
      author: extra.author,
      createdAt: extra.createdAt,
    })
  }
  return map
}

function resultOf(record, live, config) {
  const round = roundOf(record)
  const binding = record?.binding ?? {}
  const decisions = record?.decisions !== null && typeof record.decisions === 'object' ? record.decisions : {}
  const todo = reviewTodo(round, decisions)
  const mr = live?.state?.mr
  // M1：live 的 MR 快照必须与当前轮同 sha 才参与合并判定——不一致说明快照还没并进这一轮，
  // 拿它算会得到错配的「可合 / 差 N 项」。
  const roundSha = typeof round?.sha === 'string' ? round.sha : ''
  const mrSha = typeof mr?.sha === 'string' ? mr.sha : ''
  const mergeability = mr === undefined || roundSha === '' || mrSha !== roundSha
    ? null
    : evaluateMergeable({ mr, round, decisions })
  return {
    projectPath: binding.projectPath ?? '',
    iid: binding.iid ?? 0,
    webUrl: webUrlOf(config, binding),
    sourceBranch: binding.sourceBranch ?? '',
    targetBranch: binding.targetBranch ?? '',
    // I1：终态以账本记录为准（merged/closed 是永久的）；live 还没落账本时回落实时 mr。
    state: record?.terminal ?? mr?.state ?? 'unknown',
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
    // #9：问题状态与落盘共用 collectFindings，避免面板和 findings 各写一套判定。
    problems: collectFindings(record).map((finding) => {
      const problem = uiProblemOf(finding)
      const noteId = problem.instruction?.noteId
      const comment = noteId === undefined ? undefined : commentMapOf(round).get(noteId)
      if (comment !== undefined) problem.comment = comment
      return problem
    }),
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
