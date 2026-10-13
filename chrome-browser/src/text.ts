/**
 * Text shaping for page content: normalization, code-point-safe clipping, and
 * bounded JSON serialization of evaluate results.
 * @module @liyuera/dsh-chrome-browser/text
 */

/** Collapse layout whitespace and repeated blank lines; trim the ends. */
export function normalizePageText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Clip a string to at most `maxChars` code points, never splitting surrogate
 * pairs, and append an explicit truncation marker when anything was dropped.
 * @param text - the input string.
 * @param maxChars - the code-point budget.
 * @returns the clipped text plus a marker when truncated.
 */
export function clipText(text: string, maxChars: number): string {
  const points = Array.from(text)
  if (points.length <= maxChars) return text
  return `${points.slice(0, maxChars).join('')}\n…[truncated: ${points.length} chars total]`
}

/**
 * Serialize an evaluate result as pretty JSON bounded to `maxChars`; values
 * that cannot be JSON-serialized fall back to their string form. The caller
 * (chrome_eval) sees a string, never a live value.
 * @param value - the by-value result.
 * @param maxChars - the character budget.
 * @returns bounded JSON text.
 */
export function clipJson(value: unknown, maxChars: number): string {
  let text: string
  try {
    const serialized = JSON.stringify(value, null, 2)
    text = serialized === undefined ? String(value) : serialized
  } catch {
    text = String(value)
  }
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n…[truncated]`
}
