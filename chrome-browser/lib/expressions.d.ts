/**
 * Runtime.evaluate expressions the tools run inside the page main frame.
 * Expressions are deliberately self-contained IIFEs so results survive
 * serialization and cannot leak page globals into the harness.
 * @module @liyuera/dsh-chrome-browser/expressions
 */
/** Live page-facts expression: title, url, visible text, optional HTML. */
export declare function readPageExpression(includeHtml: boolean): string;
/** Viewport dimensions expression (screenshot metadata). */
export declare function viewportExpression(): string;
/** Document readiness poll expression (navigation wait). */
export declare function readyStateExpression(): string;
/**
 * Click expression. Returns the number of elements matched and clicked:
 * `all` clicks every match, otherwise only the first.
 */
export declare function clickExpression(selector: string, all: boolean): string;
/**
 * Focus-only expression for typing without replacing existing content: focuses
 * the matched element and leaves its selection untouched. Returns whether a
 * match was found.
 */
export declare function focusExpression(selector: string): string;
/**
 * Focus and select expression for typing: focuses the matched element and
 * selects its existing content (input/textarea via `select()`, other editable
 * elements via a Range over its contents). Returns whether a match was found.
 */
export declare function focusAndSelectExpression(selector: string): string;
//# sourceMappingURL=expressions.d.ts.map