/**
 * Same-origin HTTP routes the browser half calls: list tabs, bind one tab to
 * a session, read the current binding, plus the extension-bridge WebSocket
 * upgrade and its status endpoint. Static client bundles have no
 * package-private RPC channel (host.call is a dynamic-plugin builtin), so the
 * client half reaches the host through these routes.
 * @module @liyuera/dsh-chrome-browser/routes
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ServerResponse } from 'node:http';
import type { BrowserBackend } from './backend.ts';
import type { ActivityTracker } from './activity.ts';
/** JSON response writer. */
export declare function writeJson(res: ServerResponse, status: number, value: unknown): void;
/**
 * Register the plugin's browser-half routes and the extension bridge upgrade.
 * All answered ok/error shaped so the client only needs one answer type.
 * @param ctx - Cordis context (webServer read through ctx.get).
 * @param backend - the live browser backend.
 * @param activity - the in-flight call tracker the status strip reads.
 */
export declare function registerChromeRoutes(ctx: Context, backend: BrowserBackend, screenshotDir: string, activity: ActivityTracker): void;
//# sourceMappingURL=routes.d.ts.map