/**
 * Same-origin HTTP routes the browser half calls: list tabs, bind one tab to
 * a session, read the current binding, plus the extension-bridge WebSocket
 * upgrade and its status endpoint. Static client bundles have no
 * package-private RPC channel (host.call is a dynamic-plugin builtin), so the
 * client half reaches the host through these routes.
 *
 * The extension-facing routes are registered on the dsh web server AND, when
 * the dsh server listens on a different port, on this plugin's own fixed-port
 * bridge server ({@link BridgeServer}): the shipped extension dials that fixed
 * port and cannot discover an OS-assigned one.
 * @module @liyuera/dsh-chrome-browser/routes
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ServerResponse } from 'node:http';
import type { BrowserBackend } from './backend.ts';
import type { ActivityTracker } from './activity.ts';
import type { RouteCarrier } from './local-server.ts';
/**
 * Facts about the fixed-port extension bridge, surfaced by the status route so
 * a user can tell "the extension did not load" apart from "the port has no
 * listener" without reading host logs.
 */
export interface BridgeReport {
    /** Port the extension dials; the configured value, or the OS-assigned one when configured as 0. */
    port: number;
    /** Which server answers that port. */
    carrier: 'plugin' | 'webServer';
    /** Whether the port is currently served. */
    listening: boolean;
    /** Bind failure, when the plugin's own server could not own the port. */
    error?: string;
}
/** JSON response writer. */
export declare function writeJson(res: ServerResponse, status: number, value: unknown): void;
/**
 * Register the routes the installed Chrome extension calls. They live on the
 * dsh web server as before, and additionally on the plugin's fixed-port bridge
 * server when that server owns the port the extension dials.
 * @param carrier - HTTP carrier to register on.
 * @param backend - the live browser backend.
 * @param screenshotDir - directory uploads are written to.
 * @param bridge - fixed-port bridge state reported by the status route.
 * @returns disposer removing every route registered here.
 */
export declare function registerExtensionRoutes(carrier: RouteCarrier, backend: BrowserBackend, screenshotDir: string, bridge?: BridgeReport): () => void;
/**
 * Register the plugin's browser-half routes and the extension bridge.
 * All answered ok/error shaped so the client only needs one answer type.
 * @param ctx - Cordis context (webServer read through ctx.get).
 * @param backend - the live browser backend.
 * @param screenshotDir - directory uploads are written to.
 * @param activity - the in-flight call tracker the status strip reads.
 * @param bridge - fixed-port bridge state reported by the extension status route.
 */
export declare function registerChromeRoutes(ctx: Context, backend: BrowserBackend, screenshotDir: string, activity: ActivityTracker, bridge?: BridgeReport): void;
//# sourceMappingURL=routes.d.ts.map