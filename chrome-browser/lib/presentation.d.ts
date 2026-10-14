/**
 * UI-facing presentation for the eight `chrome_*` tools: the pending-call title,
 * the completed card, and the concurrency classification the scheduler reads.
 *
 * This module is UI-only — the model still receives exactly the JSON `render`
 * output, so a card may reformat freely without touching the model contract.
 * Each presenter reads back the JSON this plugin's own `render` produced rather
 * than declaring `output.presentationMeta`: that projection is persisted verbatim
 * on the session log, and re-projecting values we already render losslessly would
 * duplicate page text and evaluated values into every log.
 * @module @liyuera/dsh-chrome-browser/presentation
 */
import type { GenericCallView, GenericResultView, ToolCallKind, ToolResult } from '@deepseek-ai/dsh-tools';
/** Tab rows one card lists; a long listing stays complete in the model-facing result. */
export declare const CARD_TAB_LIMIT = 20;
/** One pending call with a semantic title. */
export declare function call(title: string, kind: ToolCallKind): GenericCallView;
/** One completed call with a semantic title and a reformatted body. */
export declare function result(title: string, text?: string): GenericResultView;
/**
 * Parse the JSON object this plugin's `render` serialized.
 * @param outcome - the settled tool result.
 * @returns the parsed object, or undefined for an error, a multi-block result, or non-JSON text.
 */
export declare function renderedJson(outcome: ToolResult): Record<string, unknown> | undefined;
/** One tab id argument as a card names it. */
export declare function tabLabel(tabId: unknown): string;
/** `chrome_tabs` pending call. */
export declare function tabsCall(): GenericCallView;
/** `chrome_tabs` completed card: the listing, capped at {@link CARD_TAB_LIMIT} rows. */
export declare function tabsResult(outcome: ToolResult): GenericResultView | undefined;
/** `chrome_read` pending call. */
export declare function readCall(args: {
    tabId?: string;
}): GenericCallView;
/** `chrome_read` completed card: the page identity plus what the model received. */
export declare function readResult(outcome: ToolResult): GenericResultView | undefined;
/** `chrome_navigate` pending call. */
export declare function navigateCall(args: {
    url: string;
    tabId?: string;
}): GenericCallView;
/** `chrome_navigate` completed card. */
export declare function navigateResult(outcome: ToolResult): GenericResultView | undefined;
/** `chrome_open` pending call. */
export declare function openCall(args: {
    url?: string;
}): GenericCallView;
/** `chrome_open` completed card. */
export declare function openResult(outcome: ToolResult): GenericResultView | undefined;
/** `chrome_screenshot` pending call. */
export declare function screenshotCall(args: {
    tabId?: string;
}): GenericCallView;
/** `chrome_screenshot` completed card: the file the model was told to read. */
export declare function screenshotResult(outcome: ToolResult): GenericResultView | undefined;
/** `chrome_click` pending call. */
export declare function clickCall(args: {
    selector: string;
    all?: boolean;
    tabId?: string;
}): GenericCallView;
/** `chrome_hover` pending call. */
export declare function hoverCall(args: {
    selector: string;
    tabId?: string;
}): GenericCallView;
/** `chrome_hover` completed card. */
export declare function hoverResult(outcome: ToolResult): GenericResultView | undefined;
/** `chrome_wait` pending call. */
export declare function waitCall(args: {
    selector: string;
    state?: string;
    tabId?: string;
}): GenericCallView;
/** `chrome_wait` completed card: whether the condition held, never "how it went". */
export declare function waitResult(outcome: ToolResult): GenericResultView | undefined;
/** `chrome_press` pending call. */
export declare function pressCall(args: {
    key: string;
    selector?: string;
    tabId?: string;
}): GenericCallView;
/** `chrome_press` completed card, naming the submit that synthetic keys make necessary. */
export declare function pressResult(outcome: ToolResult): GenericResultView | undefined;
/** `chrome_request_help` pending call. */
export declare function helpCall(args: {
    reason: string;
}): GenericCallView;
/** `chrome_request_help` completed card. */
export declare function helpResult(outcome: ToolResult): GenericResultView | undefined;
/** `chrome_close` pending call. */
export declare function closeCall(args: {
    tabId: string;
}): GenericCallView;
/** `chrome_close` completed card. */
export declare function closeResult(outcome: ToolResult): GenericResultView | undefined;
/** `chrome_select` pending call. */
export declare function selectCall(args: {
    value: string;
    selector: string;
    tabId?: string;
}): GenericCallView;
/** `chrome_select` completed card. */
export declare function selectResult(outcome: ToolResult): GenericResultView | undefined;
/** `chrome_click` completed card. Surfaces the warnings that explain a click the page may have ignored. */
export declare function clickResult(outcome: ToolResult): GenericResultView | undefined;
/** `chrome_type` pending call. Never carries the typed text: it may be a credential. */
export declare function typeCall(args: {
    selector: string;
    text: string;
    tabId?: string;
}): GenericCallView;
/** `chrome_type` completed card. The typed text stays out of the card, as in the call view. */
export declare function typeResult(outcome: ToolResult): GenericResultView | undefined;
/** `chrome_eval` pending call. */
export declare function evalCall(args: {
    expression: string;
    tabId?: string;
}): GenericCallView;
/** `chrome_eval` completed card: the serialized value the model received. */
export declare function evalResult(outcome: ToolResult): GenericResultView | undefined;
/** `chrome_console` pending call, titled by the lifecycle step it performs. */
export declare function consoleCall(args: {
    action: string;
    tabId?: string;
}): GenericCallView;
/** `chrome_console` completed card: the lifecycle result, or the entries read. */
export declare function consoleResult(outcome: ToolResult): GenericResultView | undefined;
//# sourceMappingURL=presentation.d.ts.map