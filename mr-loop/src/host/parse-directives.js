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
 *   - FID 形如 `[A-Za-z0-9_-]{4,64}`；跨评论去重按大小写不敏感；
 *   - reason 必须非空（trim 后 ≥1 字符），否则该行进 invalid；
 *   - 同一 FID 多条 → 取 note.id 最大（最新）的那条；同一条内后行覆盖前行；
 *   - reason / body 都做单行化 + 截断（reason ≤200、body ≤500，含省略号）。
 *
 * 返回值结构稳定：`{ directives: [...], invalid: [...] }`，directives 按 FID 升序
 * （大小写不敏感）排列，invalid 按扫描顺序排列。调用方（rounds / report / watcher）
 * 只读这个结构，不重复实现判定。
 */

export const DEFAULT_KINDS = Object.freeze(['waive', 'skip', 'wontfix'])
export const REASON_LIMIT = 200
export const BODY_LIMIT = 500
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

/** 单行化：控制字符（含换行 / tab）压成空格，连续空格合一，去首尾空白。 */
export function singleLine(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
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

/**
 * 解析一条评论里的指令行。返回 `{ directives, invalid }` 的增量：行号是 1 起的
 * 评论内行号；body 取整条评论正文（单行化 + 截断），供 UI 展示评论原文。
 */
function scanNote(note, allowedKinds) {
  const noteId = note?.id ?? null
  const author = authorOf(note)
  const createdAt = typeof note?.created_at === 'string' ? note.created_at : null
  const body = clipText(note?.body ?? '', BODY_LIMIT)
  const directives = []
  const invalid = []
  const lines = String(note?.body ?? '').split('\n')
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
    const [fid, ...tail] = rest.trim().split(/\s+/)
    if (fid === undefined || fid === '' || FID_RE.test(fid) === false) {
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
    directives.push({ kind, fid, reason, noteId, author, createdAt, body })
  }

  return { directives, invalid }
}

/**
 * @param {Array<object>|null|undefined} notes GitLab notes 快照（任意顺序）
 * @param {{ kinds?: string[] }} [options] 只认这些 kind（默认三种）
 * @returns {{ directives: Array<{kind:string,fid:string,reason:string,noteId:number|null,author:string|null,createdAt:string|null,body:string}>, invalid: Array<{noteId:number|null,line:number,why:string}> }}
 */
export function parseDirectives(notes, { kinds = DEFAULT_KINDS } = {}) {
  const list = Array.isArray(kinds) && kinds.length > 0 ? kinds : DEFAULT_KINDS
  const allowedKinds = new Set(list.filter((kind) => typeof kind === 'string' && kind !== ''))
  /** fid（小写）→ 最新一条指令；同 noteId 时后出现的行覆盖先出现的。 */
  const latest = new Map()
  const invalid = []

  for (const note of Array.isArray(notes) ? notes : []) {
    if (note === null || typeof note !== 'object' || note.system === true) continue
    const scan = scanNote(note, allowedKinds)
    invalid.push(...scan.invalid)
    for (const directive of scan.directives) {
      const key = directive.fid.toLowerCase()
      const previous = latest.get(key)
      const noteId = typeof directive.noteId === 'number' ? directive.noteId : -Infinity
      const previousId = typeof previous?.noteId === 'number' ? previous.noteId : -Infinity
      // `>=`：同一 note 内后出现的行覆盖前一行；跨 note 只有 id 更大才覆盖。
      if (previous === undefined || noteId >= previousId) latest.set(key, directive)
    }
  }

  const directives = [...latest.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([, directive]) => directive)
  return { directives, invalid }
}
