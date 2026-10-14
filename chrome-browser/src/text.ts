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

/** One bounded window of a page's text, plus where a reader continues from. */
export interface TextWindow {
  /** The requested slice, with no truncation marker. */
  readonly text: string
  /** Code-point offset this slice starts at, clamped into range. */
  readonly offset: number
  /** Code points in the whole document. */
  readonly total: number
  /** Offset to pass next, or absent when this window reached the end. */
  readonly nextOffset?: number
}

/**
 * Take one bounded window of page text. A truncated read is a window, not a
 * dead end: the caller gets `nextOffset` and can ask for the rest, which a
 * plain truncation cannot express.
 * @param text - the whole normalized page text.
 * @param offset - code points to skip before the window.
 * @param limit - code points the window may hold.
 * @returns the window and the continuation offset when text remains.
 */
export function windowText(text: string, offset: number, limit: number): TextWindow {
  const points = Array.from(text)
  const start = Math.min(Math.max(0, Math.trunc(offset)), points.length)
  const end = Math.min(start + Math.max(0, Math.trunc(limit)), points.length)
  const slice = points.slice(start, end).join('')
  return end < points.length
    ? { text: slice, offset: start, total: points.length, nextOffset: end }
    : { text: slice, offset: start, total: points.length }
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
