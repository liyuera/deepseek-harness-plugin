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
import { Chrome } from './chrome.ts';
import type { ResolvedChromeConfig } from './chrome.ts';
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
/** The face every chrome_* tool speaks to. */
export interface BrowserBackend {
    /** Bring the browser online; throws a user-actionable error when impossible. */
    ensure(): Promise<void>;
    /** Local tab id for the "active" fallback. */
    activeTabId(): Promise<string>;
    listTabs(): Promise<BackendTab[]>;
    openTab(url: string): Promise<BackendTab>;
    read(tabId: string, includeHtml: boolean): Promise<BackendRead>;
    navigate(tabId: string, url: string, waitLoad: boolean, waitLoadMs: number): Promise<void>;
    evaluate(tabId: string, expression: string): Promise<unknown>;
    click(tabId: string, selector: string, all: boolean): Promise<number>;
    type(tabId: string, selector: string, text: string, clear: boolean): Promise<void>;
    screenshot(tabId: string): Promise<{
        data: string;
        path?: string;
        mime?: string;
    }>;
    dispose(): void;
}
/**
 * Extension bridge backend: commands are queued, sent over the bridge
 * WebSocket, and resolved when the extension replies. The socket is attached
 * by the `/chrome-browser/ext/ws` upgrade route.
 */
export declare class ExtensionBackend implements BrowserBackend {
    private readonly config;
    /**
     * Ops a disconnect may transparently retry on the next reconnect: they are
     * side-effect free, so a lost result is safe to recompute. Side-effectful
     * ops (open/navigate/click/type) are NEVER auto-resent — the caller gets
     * the disconnect error and the model retries explicitly (no duplicate
     * tabs/clicks/typing from hidden replays).
     */
    private static readonly SAFE_RETRY_OPS;
    /**
     * In-flight dedupe keys for side-effectful ops: a second identical command
     * while the first is still in flight JOIN it instead of firing twice
     * (model retries can otherwise double-click / double-open).
     */
    private readonly inFlight;
    private conn;
    private seq;
    private readonly unacked;
    /**
     * `deadline` is an ABSOLUTE cap per command (push + 2x timeout): reconnect
     * grace may never extend a command's total lifetime, or a flapping bridge
     * (detach → resend → detach…) would keep it alive indefinitely.
     */
    private readonly pending;
    private pingTimer;
    constructor(config: ResolvedChromeConfig);
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
    navigate(tabId: string, url: string, waitLoad: boolean, waitLoadMs: number): Promise<void>;
    evaluate(tabId: string, expression: string): Promise<unknown>;
    click(tabId: string, selector: string, all: boolean): Promise<number>;
    type(tabId: string, selector: string, text: string, clear: boolean): Promise<void>;
    screenshot(tabId: string): Promise<{
        data: string;
        path?: string;
        mime?: string;
    }>;
    dispose(): void;
    private push;
    private onFrame;
    private flush;
}
/** CDP backend: the Chrome class plus per-tab endpoint operations. */
export declare class CdpBackend implements BrowserBackend {
    private readonly chrome;
    constructor(chrome: Chrome);
    ensure(): Promise<void>;
    activeTabId(): Promise<string>;
    listTabs(): Promise<BackendTab[]>;
    openTab(url: string): Promise<BackendTab>;
    read(tabId: string, includeHtml: boolean): Promise<BackendRead>;
    navigate(tabId: string, url: string, waitLoad: boolean, waitLoadMs: number): Promise<void>;
    evaluate(tabId: string, expression: string): Promise<unknown>;
    click(tabId: string, selector: string, all: boolean): Promise<number>;
    type(tabId: string, selector: string, text: string, clear: boolean): Promise<void>;
    screenshot(tabId: string): Promise<{
        data: string;
        path?: string;
        mime?: string;
    }>;
    dispose(): void;
    private withTab;
    private evaluatePage;
}
/** Build the configured backend. */
export declare function buildBackend(config: ResolvedChromeConfig): {
    backend: BrowserBackend;
    chrome?: Chrome;
};
/** The WS upgrade handler the routes register: handshake then attach. */
export declare function extensionUpgradeHandler(backend: BrowserBackend): (req: {
    headers: Record<string, string | string[] | undefined>;
}, socket: Duplex, head: Buffer) => void;
//# sourceMappingURL=backend.d.ts.map