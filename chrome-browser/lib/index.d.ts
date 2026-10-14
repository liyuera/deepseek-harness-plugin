/**
 * chrome-browser plugin, node half. Registers eight model tools that drive a
 * browser through the extension bridge (default) or the Chrome DevTools
 * Protocol (cdp fallback): list tabs, read page content, navigate, open
 * tabs, capture screenshots, click, type, and evaluate JS — plus the
 * same-origin routes the browser half uses to list tabs, bind them per
 * session, and serve the extension bridge WebSocket, the pre-step hook that
 * expands a tab citation into a context message, the `chrome-browser` agent
 * skill (when this composition exposes a skill registry), and the human-help
 * channel behind `chrome_request_help` (when it exposes a question service).
 * @module @liyuera/dsh-chrome-browser
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ChromeMode } from './chrome.ts';
/** Plugin identity. */
export declare const name = "chrome-browser";
/**
 * Services required by the host half. `webServer` is a hard dependency for
 * apply ordering: `tools` is provided early, `webServer` late in the boot
 * sequence — a plugin that only guards on `ctx.get('webServer')` would apply
 * before the HTTP carrier exists and its routes would silently never
 * register (the dev-dock plugin survives this only because its own injects,
 * settings/workspaceRegistry, resolve later than webServer).
 */
export declare const inject: string[];
/** Plugin configuration (all fields optional; schema supplies defaults). */
export interface ChromePluginConfig {
    /** Browser backend: `extension` (default, the user's real Chrome via the extension bridge) or `cdp`. */
    backend?: 'extension' | 'cdp';
    /** DevTools HTTP port (9222; cdp backends only). */
    port?: number;
    /** Explicit Chrome executable path; automatic detection when omitted. */
    chromePath?: string;
    /** Chrome `--user-data-dir` (cdp backends only). */
    profileDir?: string;
    /** `user` = the user's own copy profile; `owned` = dedicated instance (cdp backends only). */
    mode?: ChromeMode;
    /** `user` mode: relaunch Chrome with the debug port when it runs without one. */
    autoRelaunch?: boolean;
    /** Connect to an existing DevTools endpoint only; the plugin never spawns or kills Chrome. */
    attachOnly?: boolean;
    /** chrome_read visible-text budget, code points (30000). */
    readTextLimit?: number;
    /** chrome_navigate load-wait bound in milliseconds (8000; 0 = no wait). */
    waitLoadMs?: number;
    /** Per-command and readiness bound in milliseconds (15000). */
    timeoutMs?: number;
    /** Screenshot output directory; defaults to <tmp>/dsh-chrome-shots. */
    screenshotDir?: string;
}
/** Runtime configuration schema for the plugin. */
export declare const Config: z<ChromePluginConfig>;
/**
 * Register the chrome-browser plugin: eight model tools, the browser-half
 * routes (including the extension bridge upgrade), the citation expansion, and
 * one effect that disposes the backend when the plugin unmounts.
 * @param ctx - Cordis context with the tool registry and HTTP carrier.
 * @param config - the plugin configuration (schema defaults applied by the loader).
 */
export declare function apply(ctx: Context, config?: ChromePluginConfig): void;
//# sourceMappingURL=index.d.ts.map