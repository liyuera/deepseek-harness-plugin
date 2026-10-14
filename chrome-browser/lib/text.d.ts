/**
 * Text shaping for page content: normalization, code-point-safe clipping, and
 * bounded JSON serialization of evaluate results.
 * @module @liyuera/dsh-chrome-browser/text
 */
/** Collapse layout whitespace and repeated blank lines; trim the ends. */
export declare function normalizePageText(text: string): string;
/**
 * Clip a string to at most `maxChars` code points, never splitting surrogate
 * pairs, and append an explicit truncation marker when anything was dropped.
 * @param text - the input string.
 * @param maxChars - the code-point budget.
 * @returns the clipped text plus a marker when truncated.
 */
export declare function clipText(text: string, maxChars: number): string;
/** One bounded window of a page's text, plus where a reader continues from. */
export interface TextWindow {
    /** The requested slice, with no truncation marker. */
    readonly text: string;
    /** Code-point offset this slice starts at, clamped into range. */
    readonly offset: number;
    /** Code points in the whole document. */
    readonly total: number;
    /** Offset to pass next, or absent when this window reached the end. */
    readonly nextOffset?: number;
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
export declare function windowText(text: string, offset: number, limit: number): TextWindow;
/**
 * Serialize an evaluate result as pretty JSON bounded to `maxChars`; values
 * that cannot be JSON-serialized fall back to their string form. The caller
 * (chrome_eval) sees a string, never a live value.
 * @param value - the by-value result.
 * @param maxChars - the character budget.
 * @returns bounded JSON text.
 */
export declare function clipJson(value: unknown, maxChars: number): string;
//# sourceMappingURL=text.d.ts.map