/**
 * Turning captured DevTools events into console messages.
 *
 * The extension bridge runs the same mapping in `extension/service-worker.js`
 * (`consoleMessageFrom`), because the bridge cannot import host modules: the
 * two copies must stay in step, and tests/console-capture.spec.ts requires them
 * to agree on the same recorded events.
 *
 * The browser reports two families worth keeping: `Runtime.consoleAPICalled`
 * for `console.*` calls the page made, and `Log.entryAdded` for messages the
 * browser itself raises (failed requests, CSP refusals, deprecations) — the
 * second family is invisible to any wrapper around `console`, which is why
 * capture goes through the debugger.
 * @module @liyuera/dsh-chrome-browser/console-events
 */
/** One console message as a capture source reported it. */
export interface CapturedMessage {
    /** Level the source reported (`log`, `info`, `warning`, `error`, `debug`, …). */
    readonly level: string;
    /** Rendered message text. */
    readonly text: string;
    /** `url:line` of the call site, when the source reported one. */
    readonly source?: string;
}
/**
 * Map one captured DevTools event onto a console message.
 * @param method - the CDP event name.
 * @param params - the event payload.
 * @returns the message, or undefined for an event this plugin does not keep.
 */
export declare function consoleMessageFrom(method: string, params: Record<string, unknown>): CapturedMessage | undefined;
//# sourceMappingURL=console-events.d.ts.map