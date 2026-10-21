/**
 * Browser backends behind the chrome_* tools. Two implementations share one
 * interface:
 * - `ExtensionBackend` (default): commands travel over the extension bridge
 *   WebSocket (`/chrome-browser/ext/ws`) and run against the user's REAL
 *   Chrome — no restarts, no profile copies.
 * - `CdpBackend`: the Chrome DevTools Protocol path (owned/user/attach modes)
 *   used as a fallback when config selects `cdp`.
 * @module @liyuera/dsh-chrome-browser/backend
 */
import type { Duplex } from 'node:stream';
import type { CapturedMessage } from './console-events.ts';
import type { WaitState } from './expressions.ts';
import { Chrome } from './chrome.ts';
import type { ResolvedChromeConfig } from './chrome.ts';
/**
 * What a screenshot should cover.
 *
 * Absent fields mean "the visible viewport", which is what a caller who just
 * wants the page as the user sees it needs.
 */
export interface ScreenshotOptions {
    /** Capture the whole scrollable page rather than the viewport. */
    fullPage?: boolean;
    /** Capture one element instead, matched by CSS selector. */
    selector?: string;
}
/** One tab as tools and the picker see it. */
export interface BackendTab {
    id: string;
    title: string;
    url: string;
    active: boolean;
    favicon: string;
}
/** One page snapshot. */
export interface BackendRead {
    title: string;
    url: string;
    text: string;
    html: string;
}
/** One interactive element, as the page reports it. */
export interface InteractiveElement {
    /** Selector that addresses this element from the document root. */
    selector: string;
    /** ARIA role, or the tag name when the element declares none. */
    role: string;
    /** Label, text, value or placeholder — whichever the element offers first. */
    name: string;
    /** Whether the element's centre lies inside the viewport. */
    inView: boolean;
    /** Natively disabled, or marked `aria-disabled="true"`. */
    disabled: boolean;
    /** Another element sits at the element's centre, so a real click would miss it. */
    covered: boolean;
}
/** What one page's interactive elements are, and how many were left out. */
export interface BackendInventory {
    /** Page title when the listing was taken. */
    title: string;
    /** Page URL when the listing was taken. */
    url: string;
    /** Elements the inventory selector matched, before the cap. */
    matched: number;
    /** The reported elements, in document order. */
    items: InteractiveElement[];
}
/**
 * What one click actually did. `clicked` counts elements that received a
 * dispatched click event — never merely elements the selector matched, which is
 * the distinction a caller needs to tell "the page ignored it" from "nothing
 * was there". The remaining counters explain clicks that were refused or that a
 * real pointer could not have delivered.
 */
export interface ClickOutcome {
    /** Elements the selector matched. */
    matched: number;
    /** Elements that received a dispatched click event. */
    clicked: number;
    /** Matched elements whose native `disabled` state suppresses the click event. */
    disabled: number;
    /** Clicked elements with no layout box, or `display:none` / `visibility:hidden`. */
    invisible: number;
    /** Clicked elements whose centre lies outside the viewport. */
    offscreen: number;
    /** Clicked elements where a hit test at their centre lands on another element. */
    covered: number;
    /** Clicked elements carrying `aria-disabled="true"`, which dispatches but asks consumers to ignore it. */
    ariaDisabled: number;
}
/** Where captured console messages go: the host's bounded per-tab buffer. */
export type ConsoleSink = (tabId: string, message: CapturedMessage) => void;
/** What one key press did. */
export interface PressOutcome {
    /** Whether a target existed: the selector's match, or whatever had focus. */
    found: boolean;
    /** Whether the key events were dispatched. */
    pressed: boolean;
    /**
     * Whether the owning form was submitted explicitly. Synthetic key events
     * trigger no browser default action, so Enter would otherwise do nothing.
     */
    submitted: boolean;
}
/** What one `<select>` assignment did. */
export interface SelectOutcome {
    /** Elements the selector matched. */
    matched: number;
    /** Whether the value actually changed; false means the control was left alone. */
    changed: boolean;
    /** The value in effect after the attempt. */
    value: string;
    /** Values the control offered, so a failed match can name them. */
    options: string[];
    /** Why the control could not be selected, when it is not a `<select>`. */
    reason?: string;
}
/** One tool a page declares through WebMCP. */
export interface WebMcpTool {
    name: string;
    title: string;
    description: string;
    origin: string;
    /** JSON Schema of the tool's input, or null when the page declares none. */
    inputSchema: unknown;
    /** Safety hints the page attached: readOnlyHint, consequentialHint, untrustedContentHint, debugging. */
    annotations: Record<string, unknown>;
}
/** What one tab's WebMCP surface looks like. */
export interface WebMcpTools {
    /** Whether the browser and page expose a WebMCP surface at all. */
    available: boolean;
    /** Why there is no surface, or why listing failed. */
    reason?: string;
    tools: WebMcpTool[];
}
/** One WebMCP tool invocation. */
export interface WebMcpCallOutcome {
    /** Tool name the page executed. */
    tool: string;
    /** The tool's return value; absent when `navigated` or `pending` is set. */
    result?: unknown;
    /** The tool caused a navigation, so the page context changed. */
    navigated?: boolean;
    /**
     * The tool was activated but had not settled when the call returned — a
     * declarative form tool usually waits for the user to click Submit.
     */
    pending?: boolean;
    /** What the user still needs to do when `pending` is set. */
    note?: string;
}
/**
 * Map a WebMCP listing envelope from either backend onto {@link WebMcpTools}.
 * @param value - the `__dshWebmcp` envelope.
 * @returns the listing, with unreadable rows dropped.
 */
export declare function mapWebMcpTools(value: unknown): WebMcpTools;
/**
 * Map a WebMCP invocation envelope from either backend onto
 * {@link WebMcpCallOutcome}; a page-reported failure becomes a thrown error so
 * the model sees the reason and can pick another tool.
 * @param value - the `__dshWebmcp` envelope.
 * @returns the outcome.
 */
export declare function mapWebMcpCall(value: unknown): WebMcpCallOutcome;
/** What one hover did. */
export interface HoverOutcome {
    /** Elements the selector matched. */
    matched: number;
    /** Whether the first match received the hover events. */
    hovered: boolean;
}
/** The face every chrome_* tool speaks to. */
export interface BrowserBackend {
    /** Bring the browser online; throws a user-actionable error when impossible. */
    ensure(): Promise<void>;
    /** Local tab id for the "active" fallback. */
    activeTabId(): Promise<string>;
    listTabs(): Promise<BackendTab[]>;
    openTab(url: string): Promise<BackendTab>;
    /** Close one tab. Closing the last tab of a window closes that window. */
    closeTab(tabId: string): Promise<void>;
    read(tabId: string, includeHtml: boolean): Promise<BackendRead>;
    /** List one tab's interactive elements with what a reader must know before acting on them. */
    inventory(tabId: string): Promise<BackendInventory>;
    navigate(tabId: string, url: string, waitLoad: boolean, waitLoadMs: number): Promise<void>;
    /** Wait for one tab to reach `readyState === "complete"`, or the bound to elapse. */
    waitForLoad(tabId: string, waitLoadMs: number): Promise<void>;
    evaluate(tabId: string, expression: string): Promise<unknown>;
    /**
     * How the most recent `evaluate` reached the page. `'main'` is the page's own
     * world, where its JavaScript globals live. `'debugger'` is the debugger
     * protocol, taken when the page's Content-Security-Policy forbids `eval` —
     * same semantics, different mechanism, and it shows the debugger infobar on
     * that tab. `chrome_eval` reports the non-default route. Undefined before the
     * first evaluation, and on backends that have only the one route.
     */
    readonly lastEvalWorld: 'main' | 'debugger' | undefined;
    /**
     * Tools the page declares through WebMCP. `available: false` means the browser
     * exposes no WebMCP surface (flag or origin trial off) or the page implements
     * none — an answer, not an error, so the caller can fall back to DOM automation.
     */
    webmcpTools(tabId: string): Promise<WebMcpTools>;
    /**
     * Execute one page-declared WebMCP tool. `pending` means the page activated it
     * but had not settled when the call returned (a declarative form waiting for
     * the user), not that it succeeded.
     */
    webmcpCall(tabId: string, name: string, input: Record<string, unknown>): Promise<WebMcpCallOutcome>;
    click(tabId: string, selector: string, all: boolean): Promise<ClickOutcome>;
    /** Dispatch hover input on the first element matching the selector. */
    hover(tabId: string, selector: string): Promise<HoverOutcome>;
    /** Press one key on the selector's match, or on whatever currently has focus. */
    press(tabId: string, key: string, selector?: string): Promise<PressOutcome>;
    /** Set a `<select>`'s value. */
    select(tabId: string, selector: string, value: string): Promise<SelectOutcome>;
    /**
     * Poll one element condition until it holds or the bound elapses.
     * @returns whether it held; false means the bound passed, not that the page failed.
     */
    waitFor(tabId: string, selector: string, state: WaitState, timeoutMs: number): Promise<boolean>;
    type(tabId: string, selector: string, text: string, clear: boolean): Promise<void>;
    screenshot(tabId: string, options?: ScreenshotOptions): Promise<{
        data: string;
        path?: string;
        mime?: string;
    }>;
    /** Begin forwarding one tab's console output to the sink; idempotent. */
    startConsole(tabId: string): Promise<void>;
    /** Stop forwarding one tab's console output; idempotent. */
    stopConsole(tabId: string): Promise<void>;
    dispose(): void;
}
/** Read a hover result from the page or the bridge. */
export declare function mapHover(value: unknown): HoverOutcome;
/** Read a press result from the page or the bridge. */
export declare function mapPress(value: unknown): PressOutcome;
/** Read a select result from the page or the bridge. */
export declare function mapSelect(value: unknown): SelectOutcome;
/**
 * Map a click result onto {@link ClickOutcome}. A bare number is accepted as the
 * pre-0.4 bridge's "matched and clicked" count, so a Chrome extension still
 * loaded from an older package keeps working until it is reloaded.
 * @param value - the evaluated page value or the bridge's reply payload.
 * @returns the outcome, with every field defaulted.
 */
export declare function mapClickOutcome(value: unknown): ClickOutcome;
/**
 * Map an inventory result from the page or the bridge onto
 * {@link BackendInventory}. An unusable reply becomes an empty inventory rather
 * than an error: the caller asked what it can act on, and "nothing reported" is
 * a truthful answer for a page that would not answer.
 * @param value - the evaluated page value or the bridge's reply payload.
 * @returns the inventory, with unreadable entries dropped.
 */
export declare function mapInventory(value: unknown): BackendInventory;
/**
 * Extension bridge backend: commands are queued, sent over the bridge
 * WebSocket, and resolved when the extension replies. The socket is attached
 * by the `/chrome-browser/ext/ws` upgrade route.
 */
export declare class ExtensionBackend implements BrowserBackend {
    private readonly config;
    private readonly onConsole;
    /** @inheritdoc BrowserBackend.lastEvalWorld */
    lastEvalWorld: 'main' | 'debugger' | undefined;
    /**
     * Ops a disconnect may transparently retry on the next reconnect: they are
     * side-effect free or idempotent, so a lost result is safe to recompute.
     * Side-effectful ops (open/navigate/click/type) are NEVER auto-resent — the
     * caller gets the disconnect error and the model retries explicitly (no
     * duplicate tabs/clicks/typing from hidden replays). Console capture is
     * idempotent and the extension re-arms it on reconnect, so retrying it is
     * how a restarted service worker gets its capture back.
     */
    private static readonly SAFE_RETRY_OPS;
    /**
     * In-flight dedupe keys for side-effectful ops: a second identical command
     * while the first is still in flight JOIN it instead of firing twice
     * (model retries can otherwise double-click / double-open).
     */
    private readonly inFlight;
    private conn;
    /** What the extension last said about itself; null before its first hello. */
    private extension;
    /**
     * The stale build stamp an automatic reload was last asked for, or null.
     *
     * Keyed by stamp rather than by attempt: a reload that cannot move the
     * extension off one build must never be asked for twice — that would reload
     * it on every heartbeat — while a mismatch at a *different* build is a
     * different problem and deserves its own attempt, so two upgrades within one
     * host process both settle.
     */
    private reloadAskedFor;
    /**
     * Set when a build the host already asked about came back unchanged.
     *
     * The reload usually works. When it does not, the extension is re-reading a
     * DIFFERENT copy of its files than the one this plugin ships — which happens
     * when the install method changes while the host is running, because the host
     * keeps resolving its old module path while Chrome keeps serving the copy it
     * loaded. No number of reloads can close that, so it is reported rather than
     * retried.
     */
    private reloadIneffective;
    private seq;
    private readonly unacked;
    /**
     * `deadline` is an ABSOLUTE cap per command (push + 2x timeout): reconnect
     * grace may never extend a command's total lifetime, or a flapping bridge
     * (detach → resend → detach…) would keep it alive indefinitely.
     */
    private readonly pending;
    private pingTimer;
    /** Where console messages from the bridge land. */
    constructor(config: ResolvedChromeConfig, onConsole?: ConsoleSink);
    /** The WS upgrade route calls this after a successful handshake. */
    attach(socket: Duplex, head: Buffer): void;
    detach(): void;
    /** Whether the extension bridge is currently attached. */
    isConnected(): boolean;
    /** Read (or clear) the extension's persisted worker trace (diagnostics). */
    trace(clear?: boolean): Promise<unknown>;
    ensure(): Promise<void>;
    activeTabId(): Promise<string>;
    listTabs(): Promise<BackendTab[]>;
    openTab(url: string): Promise<BackendTab>;
    read(tabId: string, includeHtml: boolean): Promise<BackendRead>;
    inventory(tabId: string): Promise<BackendInventory>;
    closeTab(tabId: string): Promise<void>;
    navigate(tabId: string, url: string, waitLoad: boolean, waitLoadMs: number): Promise<void>;
    waitForLoad(tabId: string, waitLoadMs: number): Promise<void>;
    evaluate(tabId: string, expression: string): Promise<unknown>;
    webmcpTools(tabId: string): Promise<WebMcpTools>;
    webmcpCall(tabId: string, name: string, input: Record<string, unknown>): Promise<WebMcpCallOutcome>;
    click(tabId: string, selector: string, all: boolean): Promise<ClickOutcome>;
    hover(tabId: string, selector: string): Promise<HoverOutcome>;
    press(tabId: string, key: string, selector?: string): Promise<PressOutcome>;
    select(tabId: string, selector: string, value: string): Promise<SelectOutcome>;
    waitFor(tabId: string, selector: string, state: WaitState, timeoutMs: number): Promise<boolean>;
    type(tabId: string, selector: string, text: string, clear: boolean): Promise<void>;
    screenshot(tabId: string, options?: ScreenshotOptions): Promise<{
        data: string;
        path?: string;
        mime?: string;
    }>;
    startConsole(tabId: string): Promise<void>;
    stopConsole(tabId: string): Promise<void>;
    dispose(): void;
    /**
     * What the connected extension reports about itself, for the status route.
     * `stale` means its files are older than the ones this package ships, which
     * only a reload of the extension can fix.
     */
    extensionStatus(): {
        version: string;
        expectedVersion: string;
        build: string;
        expectedBuild: string;
        stale: boolean;
        autoReloadAsked: boolean;
        reloadAskedFor: string;
        reloadIneffective: boolean;
        ops: string;
    };
    /**
     * Record the extension's self-report, and ask it to reload when it is running
     * older files than this package ships.
     *
     * Chrome never re-reads an unpacked extension's files, so an upgraded plugin
     * would otherwise keep driving a stale bridge until the user reloaded it by
     * hand. `chrome.runtime.reload()` is the only thing that re-reads them.
     */
    private noteExtensionHello;
    /**
     * Refuse an op the connected extension does not advertise.
     *
     * Sending it anyway earns `unknown op` back — an internal error that says
     * nothing about the real cause, which is an extension whose files are older
     * than the plugin driving it.
     */
    private assertExtensionSupports;
    private push;
    private onFrame;
    /**
     * One pushed console batch. Anything unrecognized is dropped rather than
     * throwing: this is a wire boundary, and a malformed event must not kill the
     * connection that carries the commands.
     */
    private onEventFrame;
    private flush;
}
/** CDP backend: the Chrome class plus per-tab endpoint operations. */
export declare class CdpBackend implements BrowserBackend {
    private readonly onConsole;
    /** @inheritdoc BrowserBackend.lastEvalWorld */
    lastEvalWorld: 'main' | 'debugger' | undefined;
    private readonly chrome;
    /**
     * Long-lived sessions held open for console capture, one per capturing tab.
     * Every other operation opens and closes its own session; capture cannot,
     * because the events arrive between calls.
     */
    private readonly captures;
    constructor(chrome: Chrome, onConsole?: ConsoleSink);
    ensure(): Promise<void>;
    activeTabId(): Promise<string>;
    listTabs(): Promise<BackendTab[]>;
    openTab(url: string): Promise<BackendTab>;
    read(tabId: string, includeHtml: boolean): Promise<BackendRead>;
    inventory(tabId: string): Promise<BackendInventory>;
    closeTab(tabId: string): Promise<void>;
    navigate(tabId: string, url: string, waitLoad: boolean, waitLoadMs: number): Promise<void>;
    waitForLoad(tabId: string, waitLoadMs: number): Promise<void>;
    evaluate(tabId: string, expression: string): Promise<unknown>;
    webmcpTools(tabId: string): Promise<WebMcpTools>;
    webmcpCall(tabId: string, name: string, input: Record<string, unknown>): Promise<WebMcpCallOutcome>;
    click(tabId: string, selector: string, all: boolean): Promise<ClickOutcome>;
    hover(tabId: string, selector: string): Promise<HoverOutcome>;
    press(tabId: string, key: string, selector?: string): Promise<PressOutcome>;
    select(tabId: string, selector: string, value: string): Promise<SelectOutcome>;
    waitFor(tabId: string, selector: string, state: WaitState, timeoutMs: number): Promise<boolean>;
    type(tabId: string, selector: string, text: string, clear: boolean): Promise<void>;
    screenshot(tabId: string, options?: ScreenshotOptions): Promise<{
        data: string;
        path?: string;
        mime?: string;
    }>;
    /**
     * Clip rectangle covering the whole page, scaled down when it would not fit.
     *
     * Without a clip, `captureBeyondViewport` returns exactly one viewport — the
     * flag permits reaching past the fold, it does not ask for it.
     * @param endpoint - the tab's CDP endpoint.
     * @returns the clip rectangle, with the scale that keeps it capturable.
     */
    private pageClipOf;
    /**
     * One element's clip rectangle, or a failure naming the selector.
     * @param endpoint - the tab's CDP endpoint.
     * @param selector - CSS selector of the element to capture.
     * @returns the clip rectangle in page coordinates.
     */
    private clipOf;
    startConsole(tabId: string): Promise<void>;
    stopConsole(tabId: string): Promise<void>;
    dispose(): void;
    private withTab;
    private evaluatePage;
}
/**
 * Build the configured backend.
 * @param config - the resolved plugin configuration.
 * @param onConsole - where captured console messages land.
 * @returns the backend, plus the `Chrome` instance the CDP path owns.
 */
export declare function buildBackend(config: ResolvedChromeConfig, onConsole?: ConsoleSink): {
    backend: BrowserBackend;
    chrome?: Chrome;
};
/** The WS upgrade handler the routes register: handshake then attach. */
export declare function extensionUpgradeHandler(backend: BrowserBackend): (req: {
    headers: Record<string, string | string[] | undefined>;
}, socket: Duplex, head: Buffer) => void;
//# sourceMappingURL=backend.d.ts.map