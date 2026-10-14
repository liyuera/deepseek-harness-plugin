/**
 * Runtime.evaluate expressions the tools run inside the page main frame.
 * Expressions are deliberately self-contained IIFEs so results survive
 * serialization and cannot leak page globals into the harness.
 * @module @liyuera/dsh-chrome-browser/expressions
 */
/**
 * Press expression: dispatch one key on a matched element, or on whatever
 * currently has focus.
 *
 * Synthetic key events do not trigger the browser's own default actions, so
 * `Enter` in a form would type nothing and submit nothing. The expression
 * therefore submits the owning form explicitly and reports that it did, rather
 * than leaving the caller to guess why nothing happened.
 * @param key - the `KeyboardEvent.key` value, e.g. `Enter` or `ArrowDown`.
 * @param selector - element to focus first; omit to press on the focused element.
 * @returns a self-contained expression evaluating to `{ found, pressed, submitted }`.
 */
export declare function pressExpression(key: string, selector?: string): string;
/**
 * Select expression: set a `<select>`'s value and fire the events a controlled
 * component listens for, through the prototype setter so frameworks that patch
 * the instance still see the change.
 *
 * A value with no matching option leaves the select unchanged; the result says
 * so and lists what was available instead of reporting a success the page never
 * saw.
 * @param selector - CSS selector for the `<select>`.
 * @param value - the option value to select.
 * @returns a self-contained expression evaluating to the selection outcome.
 */
export declare function selectExpression(selector: string, value: string): string;
/** Element conditions `chrome_wait` can wait for. */
export type WaitState = 'attached' | 'detached' | 'visible' | 'hidden';
/**
 * Poll expression for one wait condition: does the selector currently satisfy
 * `state`? Resolved fresh on every poll, because the page changes between them.
 * @param selector - CSS selector to test.
 * @param state - the condition to test for.
 * @returns a self-contained expression evaluating to a boolean.
 */
export declare function waitExpression(selector: string, state: WaitState): string;
/**
 * Hover expression: dispatch the pointer events a hover-driven menu listens for
 * on the first match.
 *
 * These are synthetic: they reach listeners the page attached, but they do not
 * set the browser's own hover state, so a control revealed purely by a CSS
 * `:hover` rule will not appear. The alternative — real pointer input — is not
 * available on the extension bridge, so both backends behave the same.
 * @param selector - CSS selector to hover.
 * @returns a self-contained expression evaluating to `{ matched, hovered }`.
 */
export declare function hoverExpression(selector: string): string;
/** Live page-facts expression: title, url, visible text, optional HTML. */
export declare function readPageExpression(includeHtml: boolean): string;
/** Viewport dimensions expression (screenshot metadata). */
export declare function viewportExpression(): string;
/** Document readiness poll expression (navigation wait). */
export declare function readyStateExpression(): string;
/**
 * Click expression. Returns one outcome per call: how many elements the
 * selector matched, how many received a dispatched click, and why the rest did
 * not or may not have taken effect. `all` clicks every match, otherwise only
 * the first.
 * @param selector - CSS selector to resolve.
 * @param all - whether to click every match instead of the first.
 * @returns a self-contained expression evaluating to the click outcome.
 */
export declare function clickExpression(selector: string, all: boolean): string;
/** Elements the interactive inventory considers actionable. */
export declare const INTERACTIVE_SELECTOR: string;
/** Elements one inventory returns; a longer page is reported as capped. */
export declare const INVENTORY_LIMIT = 150;
/**
 * Interactive-element inventory expression: what a reader can act on, with the
 * selector to act on it, instead of the page's prose. Shares the click probe
 * with {@link clickExpression}, so `covered` here means the same thing it means
 * in a click result.
 *
 * The extension bridge runs the same inventory in
 * `extension/service-worker.js` (`interactiveInventory`), because it cannot
 * import host modules; tests/inventory.spec.ts requires the two to agree.
 * @returns a self-contained expression evaluating to `{ matched, items }`.
 */
export declare function inventoryExpression(): string;
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