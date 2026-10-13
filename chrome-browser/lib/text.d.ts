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