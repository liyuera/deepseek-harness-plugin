/**
 * Chrome browser lifecycle and target discovery: probe the DevTools HTTP
 * endpoint, attach to (or relaunch) the user's Chrome with a debug port in
 * `user` mode, spawn a dedicated instance in `owned` mode, list page
 * targets, and open a CDP endpoint on one tab. The plugin never terminates a
 * browser it did not spawn.
 * @module @liyuera/dsh-chrome-browser/chrome
 */
import { type ChildProcess } from 'node:child_process';
import { type CdpEndpoint } from './cdp.ts';
/** How the plugin reaches a browser via CDP (extension backend config separately). */
export type ChromeMode = 'user' | 'owned';
/** Fully-resolved plugin configuration (schema defaults already applied). */
export interface ResolvedChromeConfig {
    /** Backend: `extension` (real Chrome via the extension bridge, default) or `cdp`. */
    backend: 'extension' | 'cdp';
    /** DevTools HTTP port. */
    port: number;
    /** Explicit Chrome executable path; detection is skipped when set. `undefined` = auto-detect. */
    chromePath: string | undefined;
    /**
     * Chrome `--user-data-dir`. For `user` mode this defaults to the user's
     * real profile; override with a dedicated dir to keep the user browser
     * untouched. For `owned` mode it defaults to `<tmp>/dsh-chrome-<port>`.
     */
    profileDir: string;
    /** `user` = the user's own browser (relaunch with debug port when needed); `owned` = dedicated instance. */
    mode: ChromeMode;
    /** `user` mode only: relaunch Chrome with the debug port when it is running without one. */
    autoRelaunch: boolean;
    /** Connect to an existing DevTools endpoint without spawning or killing any browser. */
    attachOnly: boolean;
    /** Per-command and readiness bound, milliseconds. */
    timeoutMs: number;
    /** chrome_read visible-text budget, code points. */
    readTextLimit: number;
    /** chrome_navigate load-wait bound, milliseconds (0 = don't wait). */
    waitLoadMs: number;
    /** Directory for screenshot files. */
    screenshotDir: string;
}
/** One page target as the model sees it (internal ws url kept private). */
export interface ChromeTab {
    id: string;
    title: string;
    url: string;
    active: boolean;
}
/** Picker view of one tab: public fields plus a resolvable favicon url. */
export interface FaviconTab extends ChromeTab {
    favicon: string;
}
/** Internal page target view carrying the CDP websocket url. */
interface CdpTabTarget extends ChromeTab {
    wsUrl: string;
}
/** Injectable platform operations for `user`-mode attach (`autoRelaunch`). */
export interface PlatformOps {
    /** Whether a Chrome process is currently running. */
    isRunning(): Promise<boolean>;
    /** Gracefully stop Chrome (macOS Quit / Windows taskkill / Linux pkill) and wait for it to be gone. */
    stop(): Promise<void>;
}
/**
 * Favicon url for one tab: the page's own icon link when found, otherwise
 * `<origin>/favicon.ico` for http(s) pages, otherwise none.
 */
export declare function pickFaviconUrl(found: string | undefined, pageUrl: string): string;
/** Platform ops by process.platform (injectable override at construction). */
export declare function defaultPlatformOps(platform?: NodeJS.Platform): PlatformOps;
/** Browser-executable candidates per platform, most-preferred first. */
export declare function chromeCandidates(platform?: NodeJS.Platform): string[];
/**
 * Resolve the Chrome executable: the configured path must exist, otherwise
 * the first present candidate wins; nothing found throws.
 */
export declare function resolveChromePath(configured: string | undefined, candidates?: readonly string[], exists?: (path: string) => boolean): string;
/** Map one `/json/list` target to our internal view; non-page targets and targets without ws url are dropped. */
export declare function parseTabList(value: unknown): CdpTabTarget[];
/**
 * Resolve a tool's `tabId` argument: explicit id wins, then the
 * session-bound tab, then the active tab (first listed as last resort).
 */
export declare function resolveTab(tabs: readonly CdpTabTarget[], tabId: string | undefined, sessionTabId: string | undefined): CdpTabTarget;
/**
 * Owned-mode default profile: one per port, persisted under $DSH_HOME when
 * available so tabs survive OS reboots and dsh restarts.
 */
export declare function defaultProfileDir(port: number): string;
/** The user's real Chrome profile directory (source for the profile copy). */
export declare function defaultUserProfileDir(platform?: NodeJS.Platform): string;
/**
 * Profile subdirectories excluded from the user-profile copy. Chrome 136+
 * ignores `--remote-debugging-port` for profiles at the standard location, so
 * user mode relaunches from a COPY at a custom location; caches are skipped
 * (Chrome rebuilds them) while Cookies, History and logins are kept.
 */
export declare const EXCLUDED_PROFILE_DIRS: RegExp;
/** Default copy destination for user mode: persistent, custom (non-standard) location. */
export declare function defaultUserCopyProfileDir(port: number): string;
/**
 * Copy a Chrome profile to a custom location, excluding cache-style dirs.
 * When the source is absent (no Chrome profile yet) the destination is simply
 * left to Chrome to create; failures surface through `copy`.
 * @returns whether the source existed and a copy was attempted.
 */
export declare function copyUserProfileTo(source: string, dest: string, copy: (from: string, to: string) => void): boolean;
/** Default screenshot directory. */
export declare function defaultScreenshotDir(): string;
/** Apply config defaults for fields whose schema left them optional. */
export declare function resolveChromeConfig(config: Partial<ResolvedChromeConfig>, _platform?: NodeJS.Platform): ResolvedChromeConfig;
/** Injectable seams for tests. */
export interface ChromeOptions {
    /** fetch implementation (defaults to the Node global). */
    httpFetch?: typeof fetch;
    /** Extra Chrome argv appended before the initial URL. */
    extraArgs?: string[];
    /** Poll interval while waiting for DevTools readiness. */
    pollIntervalMs?: number;
    /** User-mode platform operations (defaults per process.platform). */
    platformOps?: PlatformOps;
    /** Source of the user profile for `user` mode relaunch (defaults to the standard location). */
    userProfileSource?: string;
    /** Process spawn override (defaults to child_process.spawn). */
    spawnProcess?: (path: string, args: readonly string[]) => ChildProcess;
    /** Diagnostics sink (defaults to console.warn). */
    onLog?: (message: string) => void;
}
/** Injected filesystem/process facilities for the owned-leftover reclaimer. */
export interface ReclaimDeps {
    /** Read and parse the pid file; undefined when absent or unparsable. */
    readPidFile(path: string): number | undefined;
    /** Whether the pid belongs to a live process. */
    processAlive(pid: number): boolean;
    /** The command line of the pid, or undefined when unreadable (e.g. Windows). */
    commandLineOf(pid: number): string | undefined;
    /** Send a signal to the pid. */
    kill(pid: number, signal: string): boolean;
    /** Remove the pid file (best-effort). */
    unlink(path: string): void;
}
/**
 * Claim one leftover plugin-owned Chrome from a previous run: the pid file
 * under the owned profile marks the process; it is killed only when its
 * command line still carries our `--user-data-dir` marker, so a reused pid
 * or a foreign Chrome is never touched. Best-effort, never throws.
 * @param opts - the pid file, marker profile dir, current pid and deps.
 * @returns true when a leftover process was killed.
 */
export declare function reclaimOwnedLeftover(opts: {
    pidFile: string;
    profileDir: string;
    currentPid: number;
    deps: ReclaimDeps;
}): boolean;
/**
 * Live Chrome session: one user (attached) or owned browser plus tab-level
 * CDP endpoints. Safe to use concurrently; `ensure()` is idempotent and
 * `dispose` terminates only an owned process.
 */
export declare class Chrome {
    readonly config: ResolvedChromeConfig;
    private readonly httpFetch;
    private readonly extraArgs;
    private readonly pollIntervalMs;
    private readonly onLog;
    private readonly platformOps;
    private readonly faviconCache;
    private readonly userProfileSource;
    private readonly spawnProcess;
    private proc;
    private stderrTail;
    constructor(config: ResolvedChromeConfig, options?: ChromeOptions);
    /** DevTools HTTP base url. */
    get baseUrl(): string;
    /** Whether a DevTools endpoint answers on the configured port. */
    private hasEndpoint;
    /**
     * Make the browser reachable for the configured mode: attach when
     * `attachOnly`, reuse an existing endpoint, relaunch the user's Chrome
     * with a debug port in `user` mode, or spawn a dedicated instance in
     * `owned` mode.
     */
    ensure(): Promise<void>;
    /**
     * Copy the user's real profile to the custom location Chrome will run from:
     * its standard-location profile cannot carry a debug port in Chrome 136+.
     * Failures degrade to a fresh profile there (still fully functional, just
     * without the user's tabs).
     */
    private copyUserProfile;
    /** List page tabs (type `page` only) with their CDP websocket urls. */
    private listTargets;
    /** List page tabs (type `page` only), active first. */
    listTabs(): Promise<ChromeTab[]>;
    /**
     * List page tabs enriched with a per-tab favicon url (picker surface).
     * Favicons come from the page's own `<link rel~="icon">` over its CDP
     * session, cached per origin; a missing one falls back to
     * `<origin>/favicon.ico`. Unreachable tabs degrade silently.
     */
    listTabsWithFavicons(): Promise<FaviconTab[]>;
    private cachedFavicon;
    private cacheFavicon;
    /** One page's favicon url: `<link rel~="icon">` first, origin fallback second. */
    private pageFavicon;
    /** Open a new tab (foreground) and return its public view. */
    openTab(url: string): Promise<ChromeTab>;
    /**
     * Close one tab by target id.
     *
     * Chrome answers `/json/close` with the plain text "Target is closing", so
     * this does not go through `httpJson`, which parses a JSON body.
     * @param targetId - the tab's target id, as `listTabs` reports it.
     */
    closeTab(targetId: string): Promise<void>;
    /**
     * Open a CDP endpoint on one tab. The caller owns the endpoint and must
     * `close()` it (close also detaches the session).
     * @param tabId - explicit tab id from the tool args.
     * @param sessionTabId - the session-bound tab id (undefined when none).
     * @returns the tab and its endpoint.
     */
    tabEndpoint(tabId: string | undefined, sessionTabId: string | undefined): Promise<{
        tab: CdpTabTarget;
        endpoint: CdpEndpoint;
    }>;
    /** Terminate an owned Chrome process (SIGTERM, then SIGKILL after 2s). Never touches a user-mode browser. */
    dispose(): void;
    /** The profile dir that marks a plugin-owned Chrome (never the real user profile). */
    private ownedProfileDir;
    /**
     * Reclaim a plugin-owned Chrome left over from a previous run (e.g. after
     * switching the profile from `owned` to `user`): kill it when its command
     * line still carries our profile marker. Best-effort; safe to call at
     * plugin start in any mode.
     */
    reclaimOwnedLeftover(): void;
    private removeOwnerPidFile;
    /** Shared argv: debug port, profile, origin allowlist, extras, optional startup URL. */
    private chromeArgs;
    private spawnOwnedChrome;
    private spawnUserChrome;
    private spawnChrome;
    private waitForEndpoint;
    private httpJson;
}
export {};
//# sourceMappingURL=chrome.d.ts.map