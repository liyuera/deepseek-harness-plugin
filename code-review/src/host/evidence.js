/**
 * 证据校验：finding 必须携带来自本轮变更行（turn/range）或当前文件内容（full）
 * 的逐字片段，且 location 必须落在本轮 hunk 的新侧范围内。
 *
 * 校验结论是状态而不是布尔：
 * - `ok`：片段命中变更行 / 当前文件，且 location 在 hunk 内；
 * - `missing`：模型没给 evidence（warn 模式保留，enforce 模式丢弃）；
 * - `mismatch`：片段对不上（warn 模式降级为仅报告，enforce 模式丢弃）；
 * - `outside`：location 不在本轮 hunk 新侧范围内（旧代码冒充新问题，总是丢弃）；
 * - `unreadable`：宿主拿不到文件内容（基础设施问题，保留 finding 并记录）。
 * @module @liyuera/dsh-code-review/host/evidence
 */

/**
 * 解析 `path:line` / `path:start-end` 中的行号。
 * @param {string} location
 * @returns {number | undefined}
 */
export function locationLine(location) {
  const separator = String(location).lastIndexOf(':')
  if (separator <= 0) return undefined
  const suffix = String(location).slice(separator + 1)
  const match = /^(\d+)(?:-(\d+))?$/.exec(suffix)
  if (match === null) return undefined
  return Number(match[1])
}

/**
 * 从路径段取文件名（location 的 path 部分）。
 * @param {string} location
 * @returns {string}
 */
export function locationPath(location) {
  const separator = String(location).lastIndexOf(':')
  return separator <= 0 ? String(location) : String(location).slice(0, separator)
}

const trimLine = (line) => String(line ?? '').trim()

/**
 * 构建一个文件的证据索引。`hunks` 存在时用 diff 变更行，`text` 存在时用当前文件内容。
 * @param {{hunks?: readonly object[], text?: string}} file
 * @returns {{changed: Set<string>, context: Set<string>, all: Set<string>, ranges: Array<{start:number,end:number}>} | undefined}
 */
export function evidenceIndex(file) {
  if (file === undefined || file === null) return undefined
  if (Array.isArray(file.hunks)) {
    const changed = new Set()
    const context = new Set()
    const all = new Set()
    const ranges = []
    for (const hunk of file.hunks) {
      const newLines = Number(hunk?.newLines) || 0
      const newStart = Number(hunk?.newStart) || 0
      if (newStart >= 1) {
        ranges.push({ start: newStart, end: newStart + Math.max(0, newLines) - (newLines > 0 ? 1 : 0) })
      }
      for (const raw of Array.isArray(hunk?.lines) ? hunk.lines : []) {
        const text = trimLine(String(raw).slice(1))
        if (text.length === 0) continue
        all.add(text)
        if (String(raw).startsWith('+')) changed.add(text)
        else if (String(raw).startsWith('-')) changed.add(text)
        else context.add(text)
      }
    }
    return { changed, context, all, ranges }
  }
  if (typeof file.text === 'string') {
    const all = new Set()
    for (const line of file.text.split('\n')) {
      const text = trimLine(line)
      if (text.length > 0) all.add(text)
    }
    return { changed: all, context: new Set(), all, ranges: [] }
  }
  return undefined
}

/**
 * 判断 finding 是否落在一个 hunk 的新侧范围内。
 * @param {number | undefined} line
 * @param {readonly {start:number,end:number}[]} ranges
 * @returns {boolean}
 */
function lineInRanges(line, ranges) {
  if (line === undefined) return false
  if (ranges.length === 0) return true
  return ranges.some((range) => line >= range.start && line <= range.end)
}

/**
 * 从 evidence.snippet 提取代码行：容忍模型把片段包在反引号/代码块里。
 * @param {unknown} snippet
 * @returns {string[]}
 */
function snippetLines(snippet) {
  return String(snippet ?? '')
    .split('\n')
    .map((line) => trimLine(line).replace(/^`+/, '').replace(/`+$/, '').trim())
    .filter((line) => line.length > 0)
}

/**
 * 校验单条 finding 的证据。
 * @param {object} finding 已规范化的 finding（含 location/evidence）
 * @param {{hunks?: readonly object[], text?: string} | undefined} file
 * @returns {{status: 'ok'|'missing'|'mismatch'|'outside'|'unreadable'}}
 */
export function validateFindingEvidence(finding, file) {
  if (finding?.evidence === undefined || finding?.evidence === null) return { status: 'missing' }
  const snippet = typeof finding.evidence === 'object' ? finding.evidence.snippet : finding.evidence
  const lines = snippetLines(snippet)
  if (lines.length === 0) return { status: 'missing' }
  const index = evidenceIndex(file)
  if (index === undefined) return { status: 'unreadable' }
  const line = locationLine(finding.location)
  if (!lineInRanges(line, index.ranges)) return { status: 'outside' }
  // 模型可能照抄 diff 的 `+`/`-` 前缀；两种写法都接受，但至少一行要来自变更行。
  const stripped = lines.map((text) => text.replace(/^[+-]/, '').trim())
  const contains = (set) => lines.every((text, position) => set.has(text) || set.has(stripped[position]))
  if (!contains(index.all)) return { status: 'mismatch' }
  const hasChanged = index.ranges.length === 0
    ? true
    : lines.some((text, position) => index.changed.has(text) || index.changed.has(stripped[position]))
  return hasChanged ? { status: 'ok' } : { status: 'mismatch' }
}
