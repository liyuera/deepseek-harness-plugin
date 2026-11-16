/**
 * MR 指令（豁免）解析：纯函数，不碰网络 / 时钟 / 配置。
 *
 * 用户口径（决策文档 §2.1）：指令来自 MR 评论，一行一条：
 *   #ai-waive <FID> reason=<原因>     已评估风险，本次 MR 豁免
 *   #ai-skip <FID> reason=<原因>      不适用于当前场景
 *   #ai-wontfix <FID> reason=<原因>   问题客观存在，但业务/设计决定不修
 *
 * 判定规则：
 *   - 只扫 `system !== true` 的评论；
 *   - 行首允许 0–3 个空格（4 空格 = CommonMark 缩进代码块，不算）；
 *   - 排除 `>` 引用行、``` / ~~~ 围栏代码块内的行、`#` ATX 标题行：
 *     别人引用 / 示例 / 标题里顺带写的指令都不能生效；
 *   - 扫描前剔除 HTML 注释（`<!-- ... -->`，保留行数避免行号漂移）与
 *     `备注：以下隐藏数据仅用于统计` 之后的隐藏统计块：注释/隐藏数据里的指令不生效；
 *   - FID 形如 `[A-Za-z0-9_-]{4,64}`，先去掉用户照抄评审时带上的反引号 / `**` / `__`；
 *     跨评论去重按大小写不敏感；
 *   - reason 必须包含可见字符（零宽字符不算），否则该行进 invalid；
 *   - 同一 FID 多条 → 取 note.id 最大（最新）的那条；同一条内后行覆盖前行。
 *
 * 有界输出（C1，防账本 / 工具返回膨胀）：
 *   - 单条评论只扫前 5000 行 / 200KB，超出部分记 `truncated.notes` / `truncated.lines`；
 *   - `directives` 最多 50 条（按 note.id 降序留最新），超出记 `truncated.directives`；
 *   - 评论原文不再逐条复制：`directiveNotes` 按 noteId 去重、最多 20 条（body ≤500），
 *     超出记 `truncated.directiveNotes`；
 *   - `invalid` 只留 `{ count, samples（前 5 条） }`，不逐条落盘。
 *
 * 返回值结构稳定：directives 按 FID 升序（大小写不敏感），directiveNotes 按 noteId 降序。
 */

export const DEFAULT_KINDS = Object.freeze(['waive', 'skip', 'wontfix'])
export const REASON_LIMIT = 200
export const BODY_LIMIT = 500
export const DIRECTIVE_CAP = 50
export const DIRECTIVE_NOTES_CAP = 20
export const INVALID_SAMPLES = 5
export const MAX_NOTE_LINES = 5000
export const MAX_NOTE_BYTES = 200 * 1024
/** FID 允许的字符与长度；`re` 锚定整串。 */
export const FID_RE = /^[A-Za-z0-9_-]{4,64}$/

const BLOCKQUOTE_RE = /^ {0,3}>/
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
// ATX 标题必须 `#` 后有空格；`#ai-waive` 因此不是标题（它也不是合法 ATX 标题）。
const HEADING_RE = /^ {0,3}#{1,6}[ \t]/
// 指令前缀：`#ai-` 后必须紧跟小写 kind；kind 后再要求空白或行尾（防止 `#ai-waivex`）。
const DIRECTIVE_HEAD_RE = /^ {0,3}#ai-([a-z][a-z0-9_-]*)(?:[ \t]+(.*))?$/
// FID 之后必须是 `reason=`（允许 = 两侧空格）；前面不允许再夹别的词。
const REASON_RE = /^[ \t]*reason[ \t]*=[ \t]*(.*)$/
// 任何一行以指令前缀开头（不校验格式）的评论都算「指令评论」，不再当普通评论展示。
const DIRECTIVE_LINE_RE = /^ {0,3}#ai-/m
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g
const HIDDEN_MARKER_RE = /备注\s*[:：]\s*以下隐藏数据仅用于统计/
const ZERO_WIDTH_RE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g
const encoder = new TextEncoder()

/** 单行化：控制字符（含换行 / tab）压成空格，去掉零宽字符，连续空格合一，去首尾空白。 */
export function singleLine(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(ZERO_WIDTH_RE, '')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/** 单行化 + 截断：保证结果长度 ≤ max（截断时末尾是 `…`）。 */
export function clipText(value, max) {
  const text = singleLine(value)
  if (text.length <= max) return text
  if (max <= 0) return ''
  return `${text.slice(0, max - 1)}…`
}

/** 评论作者：优先 username，其次 name，缺失为 null。 */
export function authorOf(note) {
  const author = note?.author
  if (author === null || typeof author !== 'object') return null
  if (typeof author.username === 'string' && author.username.trim() !== '') return author.username
  if (typeof author.name === 'string' && author.name.trim() !== '') return author.name
  return null
}

/** 这条评论里有没有指令行（不校验格式）：rounds 用它把指令评论挡在「普通评论」之外。 */
export function hasDirectiveLine(body) {
  return typeof body === 'string' && DIRECTIVE_LINE_RE.test(body)
}

/**
 * 可见正文：剔除隐藏统计块（其内容不是给人看的）与 HTML 注释。
 * HTML 注释替换成等量换行，保证后续行号仍是原评论里的行号。
 */
function visibleBody(body) {
  let text = String(body ?? '')
  const markerIndex = text.search(HIDDEN_MARKER_RE)
  if (markerIndex >= 0) {
    const lineStart = text.lastIndexOf('\n', markerIndex) + 1
    const prefix = text.slice(lineStart, markerIndex)
    // 隐藏块标记通常单独占一行（`> 备注：...`）：整行切掉，别把 `> ` 尾巴留进正文。
    text = text.slice(0, /^[ \t]*>[ \t]*$/.test(prefix) ? lineStart : markerIndex)
  }
  return text.replace(HTML_COMMENT_RE, (match) => '\n'.repeat((match.match(/\n/g) ?? []).length))
}

/** 只扫前 MAX_NOTE_LINES 行 / MAX_NOTE_BYTES 字节；返回扫描行与未扫行数。 */
function scanLimits(text) {
  const allLines = text.split('\n')
  const lineCap = Math.min(allLines.length, MAX_NOTE_LINES)
  let end = 0
  let bytes = 0
  while (end < lineCap) {
    const size = encoder.encode(allLines[end]).length + (end === 0 ? 0 : 1)
    if (bytes + size > MAX_NOTE_BYTES) break
    bytes += size
    end += 1
  }
  return { lines: allLines.slice(0, end), skipped: allLines.length - end }
}

/** 用户照抄评审时可能带反引号 / `**` / `__`：迭代剥掉首尾标记再校验。 */
function cleanFidToken(value) {
  let text = String(value ?? '').trim()
  for (let round = 0; round < 4; round += 1) {
    const next = text
      .replace(/^`+/, '')
      .replace(/`+$/, '')
      .replace(/^\*\*+/, '')
      .replace(/\*\*+$/, '')
      .replace(/^__+/, '')
      .replace(/__+$/, '')
      .trim()
    if (next === text) break
    text = next
  }
  return text
}

/** 扫描一条评论；invalid 是扫描到的无效行，preview 只在该评论有有效指令时生成。 */
function scanNote(note, allowedKinds) {
  const noteId = note?.id ?? null
  const author = authorOf(note)
  const createdAt = typeof note?.created_at === 'string' ? note.created_at : null
  const visible = visibleBody(note?.body)
  const { lines, skipped } = scanLimits(visible)
  const directives = []
  const invalid = []
  let fence = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lineNo = index + 1

    if (fence !== null) {
      const close = FENCE_CLOSE_RE.exec(line)
      if (close !== null && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null
      continue
    }
    // 引用行整行剔除：引用别人的豁免不能当成自己的指令。
    if (BLOCKQUOTE_RE.test(line)) continue
    const open = FENCE_OPEN_RE.exec(line)
    if (open !== null) {
      fence = open[1]
      continue
    }
    // 标题行整行剔除：`## 说明 #ai-waive ...` 不是指令（`#ai-waive` 本身不是标题）。
    if (HEADING_RE.test(line)) continue
    const head = DIRECTIVE_HEAD_RE.exec(line)
    if (head === null) continue
    const kind = head[1]
    if (allowedKinds.has(kind) === false) continue

    const rest = head[2] ?? ''
    const [token, ...tail] = rest.trim().split(/\s+/)
    const fid = cleanFidToken(token)
    if (fid === '' || FID_RE.test(fid) === false) {
      invalid.push({ noteId, line: lineNo, why: 'invalid-fid' })
      continue
    }
    const reasonMatch = REASON_RE.exec(tail.join(' '))
    if (reasonMatch === null) {
      invalid.push({ noteId, line: lineNo, why: 'missing-reason' })
      continue
    }
    const reason = clipText(reasonMatch[1], REASON_LIMIT)
    if (reason === '') {
      invalid.push({ noteId, line: lineNo, why: 'empty-reason' })
      continue
    }
    directives.push({ kind, fid, reason, noteId, author, createdAt })
  }

  return {
    directives,
    invalid,
    skipped,
    preview: directives.length === 0 ? null : clipText(visible, BODY_LIMIT),
  }
}

const noteIdOf = (directive) => (typeof directive?.noteId === 'number' ? directive.noteId : -Infinity)
const byNewest = (left, right) => noteIdOf(right) - noteIdOf(left)
const byFid = (left, right) => {
  const a = String(left?.fid ?? '').toLowerCase()
  const b = String(right?.fid ?? '').toLowerCase()
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * @param {Array<object>|null|undefined} notes GitLab notes 快照（任意顺序）
 * @param {{ kinds?: string[] }} [options] 只认这些 kind（默认三种）
 * @returns {{
 *   directives: Array<{kind:string,fid:string,reason:string,noteId:number|null,author:string|null,createdAt:string|null}>,
 *   directiveNotes: Array<{noteId:number|null, body:string}>,
 *   invalid: {count:number, samples:Array<{noteId:number|null,line:number,why:string}>},
 *   truncated: {directives:number, directiveNotes:number, notes:number, lines:number},
 * }}
 */
export function parseDirectives(notes, { kinds = DEFAULT_KINDS } = {}) {
  const list = Array.isArray(kinds) && kinds.length > 0 ? kinds : DEFAULT_KINDS
  const allowedKinds = new Set(list.filter((kind) => typeof kind === 'string' && kind !== ''))
  /** fid（小写）→ 最新一条指令；同 noteId 时后出现的行覆盖先出现的。 */
  const latest = new Map()
  /** noteId → 该评论的可见正文预览（只在有有效指令时存在）。 */
  const noteBodies = new Map()
  const invalidSamples = []
  let invalidCount = 0
  const truncated = { directives: 0, directiveNotes: 0, notes: 0, lines: 0 }

  for (const note of Array.isArray(notes) ? notes : []) {
    if (note === null || typeof note !== 'object' || note.system === true) continue
    const scan = scanNote(note, allowedKinds)
    if (scan.skipped > 0) {
      truncated.notes += 1
      truncated.lines += scan.skipped
    }
    invalidCount += scan.invalid.length
    for (const sample of scan.invalid) {
      if (invalidSamples.length < INVALID_SAMPLES) invalidSamples.push(sample)
    }
    for (const directive of scan.directives) {
      const key = directive.fid.toLowerCase()
      const previous = latest.get(key)
      // `>=`：同一 note 内后出现的行覆盖前一行；跨 note 只有 id 更大才覆盖。
      if (previous === undefined || noteIdOf(directive) >= noteIdOf(previous)) {
        latest.set(key, directive)
        if (scan.preview !== null) noteBodies.set(directive.noteId, scan.preview)
      }
    }
  }

  const all = [...latest.values()]
  const kept = [...all].sort(byNewest).slice(0, DIRECTIVE_CAP)
  truncated.directives = Math.max(0, all.length - kept.length)

  // 只给最终生效的指令保留评论原文：被覆盖 / 被 cap 掉的评论不再落盘。
  const retained = new Map()
  for (const directive of kept) {
    const noteId = directive.noteId
    if (typeof noteId !== 'number' || retained.has(noteId)) continue
    const body = noteBodies.get(noteId)
    if (body !== undefined) retained.set(noteId, body)
  }
  const noteIds = [...retained.keys()].sort((left, right) => right - left)
  truncated.directiveNotes = Math.max(0, noteIds.length - DIRECTIVE_NOTES_CAP)
  const directiveNotes = noteIds.slice(0, DIRECTIVE_NOTES_CAP).map((noteId) => ({ noteId, body: retained.get(noteId) }))

  return {
    directives: kept.sort(byFid),
    directiveNotes,
    invalid: { count: invalidCount, samples: invalidSamples },
    truncated,
  }
}
