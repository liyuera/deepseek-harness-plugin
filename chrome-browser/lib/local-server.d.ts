/**
 * The plugin's own loopback HTTP carrier for the Chrome extension bridge.
 *
 * The shipped extension dials a fixed port (`ws://127.0.0.1:21987/...`) because
 * its service worker cannot discover an OS-assigned one. The dsh web server
 * does not own that port — the desktop client asks the OS for a free port
 * (`--port 0`) — so the plugin serves the extension-facing routes itself on
 * the fixed bridge port and keeps the dsh server for the browser half. When
 * the dsh server does listen on that exact port its own registration is the
 * bridge and no second listener starts.
 * @module @liyuera/dsh-chrome-browser/local-server
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
/** HTTP handler a carrier invokes for one request. */
export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
/** Upgrade handler a carrier invokes after the request switched protocols. */
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
/**
 * What route registration needs from an HTTP carrier. The dsh web server
 * satisfies this face, and so does {@link BridgeServer}; keeping it structural
 * leaves the service type private (the dev-dock pattern).
 */
export interface RouteCarrier {
    register(route: {
        kind: 'exact' | 'prefix';
        path: string;
        handler: HttpHandler;
    }): () => void;
    registerUpgrade(route: {
        path: string;
        handler: UpgradeHandler;
    }): () => void;
}
/**
 * Loopback-only HTTP server owning the extension-facing routes. Node built-ins
 * only: the bridge handshake and frames come from `./ws.ts`.
 */
export declare class BridgeServer implements RouteCarrier {
    private readonly server;
    private readonly httpRoutes;
    private readonly upgradeRoutes;
    /**
     * Accepted upgrade sockets. `server.close()` and `closeAllConnections()` do
     * not reach upgraded connections: the bridge must destroy them itself, or a
     * host process that lingers after shutdown keeps the extension's socket open
     * and the extension never reconnects to the next host.
     */
    private readonly upgraded;
    private boundPort;
    /** The pending bind, so `close` requested during it still closes the listener. */
    private listenPromise;
    constructor();
    /** The port actually bound; `undefined` before `listen` resolves and after `close`. */
    get port(): number | undefined;
    /** Register one exact-path HTTP route; `prefix` is a dsh-carrier feature this server does not have. */
    register(route: {
        kind: 'exact' | 'prefix';
        path: string;
        handler: HttpHandler;
    }): () => void;
    /** Register one exact-path WebSocket upgrade route. */
    registerUpgrade(route: {
        path: string;
        handler: UpgradeHandler;
    }): () => void;
    /**
     * Bind the loopback port.
     * @param port - fixed port, or 0 to let the OS assign one (tests and diagnostics).
     * @returns the bound port.
     */
    listen(port: number): Promise<number>;
    /** Stop listening and drop every registered route. Safe to call when never listened. */
    close(): Promise<void>;
    private dispatchHttp;
    private dispatchUpgrade;
}
//# sourceMappingURL=local-server.d.ts.map