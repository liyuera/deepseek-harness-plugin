/**
 * T4：findings 沉淀（只记录，不做分析）。
 *
 * 两件事共用一个模块，避免「UI 一套判定、落盘另一套」：
 *   1. `collectFindings(record)`：FID 粒度的问题状态（open / waived / skip / wontfix / fixed），
 *      复用 mergeable.js 的处置口径（MR 指令 + 账本 decisions + 与上一轮 FID 对比）；
 *   2. `createFindingsStore()`：append-only JSONL，一个工作区 + 一个 MR 一个文件；
 *      只在状态变化时追加，跨重启按已有文件去重；写入失败只告警，绝不打断主流程。
 *
 * 位置：`<findingsDir>/<workspace>/findings/<projectPath 的 / 换成 __>__<iid>.jsonl`，
 * 目录 0700、文件 0600；单文件超过 `maxBytes` 滚动成 `<name>.1.jsonl`（只保留一代）。
 * 数据只来自 MR（+ 账本），不写进用户仓库。
 */
import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { expandHome } from './ledger.js'
import { decisionFor, directiveFor, isDisposed, isDisposedFinding } from './mergeable.js'

export const FINDINGS_VERSION = 1
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

/** 字段上限：JSONL 里每行都是「一行」，长文本先单行化再截断（含末尾省略号不超过上限）。 */
const LEVEL_LIMIT = 40
const TYPE_LIMIT = 60
const FILE_LIMIT = 300
const PROBLEM_LIMIT = 500
const SUGGESTION_LIMIT = 500
const REASON_LIMIT = 200
const SNIPPET_LIMIT = 400

const ROLLED_SUFFIX = '.1.jsonl'

/** 坏文件 / 外部超大文件不做全量扫描：正常文件受 maxBytes 约束，扫描上限只管异常情况。 */
const MAX_SCAN_BYTES = 64 * 1024 * 1024

/** 压成单行并截断到 limit（含省略号）：第三方 note 内容不能改写 JSONL 行边界。 */
function text(value, limit) {
  if (value === null || value === undefined) return undefined
  const collapsed = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
  if (collapsed === '') return undefined
  return collapsed.length > limit ? `${collapsed.slice(0, Math.max(0, limit - 1))}…` : collapsed
}

const sanitizeId = (value) => (typeof value === 'string' && value.trim() !== '' ? value : undefined)

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

/** 行号：优先 finding.line；评审模板只给 `位置: src/a.js:3` 时从中取（纯提取，不做分析）。 */
function lineOf(item) {
  if (Number.isSafeInteger(item?.line) && item.line > 0) return item.line
  const location = typeof item?.location === 'string' ? item.location.trim() : ''
  const match = /:(\d+)(?:-\d+)?$/.exec(location)
  if (match === null) return undefined
  const parsed = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/** 复验次数缺失就是 null（0 是合法值，不能被 || 吃掉）。 */
const reverifyOf = (item) => (typeof item?.reverifyCount === 'number' && Number.isFinite(item.reverifyCount)
  ? item.reverifyCount
  : null)

/** `kind → status`：waive 展示为 waived，skip / wontfix 保留原词（供后续按处置方式挖掘）。 */
const statusOf = (kind) => (kind === 'waive' ? 'waived' : kind)

function instructionOf(source) {
  if (source === null || typeof source !== 'object') return null
  const kind = typeof source.kind === 'string' && source.kind !== '' ? source.kind : null
  if (kind === null) return null
  return {
    kind,
    reason: text(source.reason, REASON_LIMIT) ?? null,
    noteId: Number.isSafeInteger(source.noteId) ? source.noteId : null,
  }
}

/**
 * FID 粒度的当前问题列表（UI 与 JSONL 落盘共用）。
 *
 * @param {object} record service 状态或账本记录（只读 binding / rounds / decisions）
 * @returns {Array<{fid:string,file:string|undefined,line:number|undefined,level:string,
 *   type:string|null,gateCategory:string|null,problem:string,suggestion:string|undefined,
 *   snippet:string|undefined,reverifyCount:number|null,status:'open'|'waived'|'skip'|'wontfix'|'fixed',
 *   instruction:{kind:string,reason:string|null,noteId:number|null}|null,fixedAtRound?:number}>}
 */
export function collectFindings(record) {
  const round = roundOf(record)
  const previous = previousRoundOf(record)
  const decisions = record?.decisions !== null && typeof record.decisions === 'object' ? record.decisions : {}
  const current = findingsOf(round)
  const currentFids = new Set(current.map((item) => String(item?.fid ?? '').toUpperCase()))

  const findings = current.map((item) => {
    const fid = sanitizeId(item?.fid) ?? '?'
    // 与 mergeable.js 共用 decisionFor 的大小写兜底；账本处置优先，没有时看 MR 指令。
    const decision = decisionFor(decisions, item?.fid)
    const fromLedger = isDisposed(decision) ? decision.kind : null
    const directive = directiveFor(round, item?.fid)
    const source = fromLedger !== null ? decision : directive
    const kind = fromLedger ?? directive?.kind ?? null
    return {
      fid,
      file: text(item?.file, FILE_LIMIT),
      line: lineOf(item),
      level: text(item?.level, LEVEL_LIMIT) ?? '',
      type: text(item?.type, TYPE_LIMIT) ?? null,
      gateCategory: text(item?.gateCategory, TYPE_LIMIT) ?? null,
      problem: text(item?.problem, PROBLEM_LIMIT) ?? '',
      suggestion: text(item?.suggestion, SUGGESTION_LIMIT),
      snippet: text(item?.snippet ?? item?.sourceSnippet, SNIPPET_LIMIT),
      reverifyCount: reverifyOf(item),
      status: kind === null ? 'open' : statusOf(kind),
      instruction: kind === null ? null : instructionOf(source),
    }
  })

  // 上一轮存在、本轮消失的 FID 记 fixed（已处置的不记：它没有「修好」的含义）。
  for (const item of findingsOf(previous)) {
    const fid = String(item?.fid ?? '')
    if (fid === '' || currentFids.has(fid.toUpperCase())) continue
    if (isDisposedFinding(round, decisions, fid)) continue
    findings.push({
      fid,
      file: text(item?.file, FILE_LIMIT),
      line: lineOf(item),
      level: text(item?.level, LEVEL_LIMIT) ?? '',
      type: text(item?.type, TYPE_LIMIT) ?? null,
      gateCategory: text(item?.gateCategory, TYPE_LIMIT) ?? null,
      problem: text(item?.problem, PROBLEM_LIMIT) ?? '',
      suggestion: text(item?.suggestion, SUGGESTION_LIMIT),
      snippet: text(item?.snippet ?? item?.sourceSnippet, SNIPPET_LIMIT),
      reverifyCount: reverifyOf(item),
      status: 'fixed',
      instruction: null,
      fixedAtRound: Number.isSafeInteger(round?.n) ? round.n : undefined,
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// JSONL 存储
// ---------------------------------------------------------------------------

const rolledOf = (file) => `${file.replace(/\.jsonl$/, '')}${ROLLED_SUFFIX}`

/** 工作区名 = 仓库根目录名；取不到时用 unknown（不拿 cwd / 会话名猜）。 */
const workspaceOf = (repoRoot) => {
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') return 'unknown'
  const base = basename(repoRoot)
  return base === '' || base === '.' || base === '..' ? 'unknown' : base
}

/** projectPath 转义：GitLab 全路径的 `/` 换成 `__`。 */
const escapedProject = (projectPath) => {
  const raw = typeof projectPath === 'string' ? projectPath.trim() : ''
  return raw === '' ? 'unknown' : raw.replace(/\//g, '__')
}

/** 去重键：同一 MR 内 (fid, status, instruction.kind, instruction.noteId) 不变就不追加。 */
const keyOf = (entry) => [
  entry?.fid ?? '',
  entry?.status ?? '',
  entry?.instruction?.kind ?? '',
  entry?.instruction?.noteId ?? '',
].join('\u0000')

/** 一行 JSONL 的固定结构（字段缺失一律 null，不猜默认值）。 */
function entryOf(finding, context) {
  return {
    v: FINDINGS_VERSION,
    at: context.at,
    workspace: context.workspace,
    projectPath: context.projectPath,
    iid: context.iid,
    sha: context.sha,
    round: context.round,
    fid: finding.fid,
    file: finding.file ?? null,
    line: finding.line ?? null,
    level: finding.level === '' ? null : finding.level,
    type: finding.type ?? null,
    gateCategory: finding.gateCategory ?? null,
    problem: finding.problem ?? '',
    suggestion: finding.suggestion ?? null,
    reverifyCount: finding.reverifyCount ?? null,
    status: finding.status,
    instruction: finding.instruction === null
      ? null
      : { kind: finding.instruction.kind, reason: finding.instruction.reason, noteId: finding.instruction.noteId },
  }
}

/**
 * @param {{ dir?: string, maxBytes?: number, logger?: { warn?: Function }, now?: () => number }} [options]
 */
export function createFindingsStore({
  dir = '~/.dsh/workspace',
  maxBytes = DEFAULT_MAX_BYTES,
  logger = undefined,
  now = Date.now,
} = {}) {
  // 路径兜底：空串 / 非字符串一律退回默认，绝不把「相对当前仓库」当 findings 根目录写进去。
  const root = expandHome(typeof dir === 'string' && dir.trim() !== '' ? dir.trim() : '~/.dsh/workspace')
  // 阈值只做兜底：非法值退回默认，不因一个坏配置让数据沉淀整体失效。
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES
  /** file → { chain: Promise, keys: Set|null, size: number } */
  const files = new Map()

  const warn = (error) => logger?.warn?.(`[mr-loop] findings 写入失败：${error?.message ?? error}`)

  function stateOf(file) {
    let state = files.get(file)
    if (state === undefined) {
      state = { chain: Promise.resolve(), keys: null, size: 0 }
      files.set(file, state)
    }
    return state
  }

  /** 同一文件的写串行；失败只告警并吞掉——数据沉淀是旁路，不能把异常抛回主流程。 */
  function enqueue(file, task) {
    const state = stateOf(file)
    const next = state.chain.then(task, task)
    const guarded = next.catch((error) => {
      warn(error)
      return 0
    })
    state.chain = guarded
    return guarded
  }

  /** 启动后第一次写某文件前读回已有键：跨重启不重复追加。坏行 / 读失败尽力而为跳过。 */
  async function readKeys(file) {
    const keys = new Set()
    // 滚动后旧键在 `.1` 里：两代都读，跨重启才真正不重复。
    for (const candidate of [file, rolledOf(file)]) {
      let raw
      try {
        const info = await stat(candidate)
        if (info.size > MAX_SCAN_BYTES) continue
        raw = await readFile(candidate, 'utf8')
      } catch {
        continue
      }
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const parsed = JSON.parse(trimmed)
          if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed) === false) {
            keys.add(keyOf(parsed))
          }
        } catch {
          /* 坏行跳过，不影响其它行 */
        }
      }
    }
    return keys
  }

  async function sizeOf(file) {
    try {
      return (await stat(file)).size
    } catch {
      return 0
    }
  }

  async function write(file, directory, entries) {
    const state = stateOf(file)
    if (state.keys === null) {
      state.keys = await readKeys(file)
      state.size = await sizeOf(file)
    }
    const fresh = entries.filter((entry) => state.keys.has(keyOf(entry)) === false)
    if (fresh.length === 0) return 0
    const payload = `${fresh.map((entry) => JSON.stringify(entry)).join('\n')}\n`
    const bytes = Buffer.byteLength(payload, 'utf8')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    // 超阈值滚动：旧内容改名 `.1`（只保留一代），本批写进新文件；内存里的键集不清空，
    // 避免滚动后同一状态被当成新记录重复追加。
    if (state.size > 0 && state.size + bytes > limit) {
      const rolled = rolledOf(file)
      await rm(rolled, { force: true })
      await rename(file, rolled)
      state.size = 0
    }
    await appendFile(file, payload, { encoding: 'utf8', mode: 0o600 })
    state.size += bytes
    for (const entry of fresh) state.keys.add(keyOf(entry))
    return fresh.length
  }

  /** 把一份状态快照里的 FID 增量写进对应 MR 的 JSONL。没有 finding / 绑定不完整 → 什么都不做。 */
  function record(state) {
    try {
      const target = targetOf(state)
      if (target === null) return Promise.resolve(0)
      return enqueue(target.file, () => write(target.file, target.directory, target.entries))
    } catch (error) {
      warn(error)
      return Promise.resolve(0)
    }
  }

  function targetOf(state) {
    const binding = state?.binding
    if (binding === null || typeof binding !== 'object') return null
    const iid = binding.iid
    if (Number.isSafeInteger(iid) === false || iid <= 0) return null
    const projectPath = typeof binding.projectPath === 'string' ? binding.projectPath.trim() : ''
    if (projectPath === '') return null
    const findings = collectFindings(state)
    if (findings.length === 0) return null
    const round = roundOf(state)
    const workspace = workspaceOf(binding.repoRoot)
    const directory = join(root, workspace, 'findings')
    const file = join(directory, `${escapedProject(projectPath)}__${iid}.jsonl`)
    const context = {
      at: new Date(now()).toISOString(),
      workspace,
      projectPath,
      iid,
      sha: typeof round?.sha === 'string' && round.sha !== '' ? round.sha : null,
      round: Number.isSafeInteger(round?.n) ? round.n : null,
    }
    return { directory, file, entries: findings.map((finding) => entryOf(finding, context)) }
  }

  /** 等所有在途写完成（测试 / 收尾用；正常路径不 await，保持 fire-and-forget）。 */
  async function flush() {
    await Promise.all([...files.values()].map((state) => state.chain))
  }

  return { record, flush }
}
