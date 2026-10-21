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
import { createServer } from 'node:http';
/**
 * Loopback-only HTTP server owning the extension-facing routes. Node built-ins
 * only: the bridge handshake and frames come from `./ws.ts`.
 */
export class BridgeServer {
    server;
    httpRoutes = new Map();
    upgradeRoutes = new Map();
    /**
     * Accepted upgrade sockets. `server.close()` and `closeAllConnections()` do
     * not reach upgraded connections: the bridge must destroy them itself, or a
     * host process that lingers after shutdown keeps the extension's socket open
     * and the extension never reconnects to the next host.
     */
    upgraded = new Set();
    boundPort;
    /** The pending bind, so `close` requested during it still closes the listener. */
    listenPromise;
    constructor() {
        this.server = createServer((req, res) => this.dispatchHttp(req, res));
        this.server.on('upgrade', (req, socket, head) => {
            const upgraded = socket;
            this.upgraded.add(upgraded);
            upgraded.once('close', () => this.upgraded.delete(upgraded));
            this.dispatchUpgrade(req, upgraded, head);
        });
        // A malformed request must not take the host down: the bridge is exposed to
        // whatever the browser sends, including half-closed sockets.
        this.server.on('clientError', (_error, socket) => {
            socket.destroy();
        });
        // Bind failures are reported through `listen`'s rejection. A later error
        // (an accepted socket hitting EMFILE, say) has no recovery path here, but
        // without a listener Node raises it as an uncaught exception and takes the
        // Host down with it.
        this.server.on('error', () => { });
    }
    /** The port actually bound; `undefined` before `listen` resolves and after `close`. */
    get port() {
        return this.boundPort;
    }
    /** Register one exact-path HTTP route; `prefix` is a dsh-carrier feature this server does not have. */
    register(route) {
        if (route.kind !== 'exact')
            throw new Error('the bridge server only serves exact routes');
        this.httpRoutes.set(route.path, route.handler);
        return () => {
            if (this.httpRoutes.get(route.path) === route.handler)
                this.httpRoutes.delete(route.path);
        };
    }
    /** Register one exact-path WebSocket upgrade route. */
    registerUpgrade(route) {
        this.upgradeRoutes.set(route.path, route.handler);
        return () => {
            if (this.upgradeRoutes.get(route.path) === route.handler)
                this.upgradeRoutes.delete(route.path);
        };
    }
    /**
     * Bind the loopback port.
     * @param port - fixed port, or 0 to let the OS assign one (tests and diagnostics).
     * @returns the bound port.
     */
    async listen(port) {
        if (this.boundPort !== undefined || this.listenPromise !== undefined) {
            throw new Error('the bridge server is already listening');
        }
        const pending = (async () => {
            await new Promise((resolve, reject) => {
                const onError = (error) => {
                    this.server.off('listening', onListening);
                    reject(error);
                };
                const onListening = () => {
                    this.server.off('error', onError);
                    resolve();
                };
                this.server.once('error', onError);
                this.server.once('listening', onListening);
                // Loopback only: the extension runs on this machine, and the bridge has no
                // authentication of its own.
                this.server.listen(port, '127.0.0.1');
            });
            const address = this.server.address();
            this.boundPort = typeof address === 'object' && address !== null ? address.port : port;
            return this.boundPort;
        })();
        this.listenPromise = pending;
        try {
            return await pending;
        }
        catch (error) {
            this.listenPromise = undefined;
            throw error;
        }
    }
    /** Stop listening and drop every registered route. Safe to call when never listened. */
    async close() {
        this.httpRoutes.clear();
        this.upgradeRoutes.clear();
        const pending = this.listenPromise;
        this.listenPromise = undefined;
        if (pending !== undefined) {
            try {
                // Without this await, a bind that lands after close() would leave a
                // listener nobody owns: routes are already gone, so it can only make
                // the next plugin load fail with EADDRINUSE.
                this.boundPort = await pending;
            }
            catch {
                // The bind never succeeded; there is no listener to close.
            }
        }
        this.boundPort = undefined;
        if (!this.server.listening)
            return;
        for (const upgraded of this.upgraded) {
            // Destroyed here, not left to the process exit: a stuck shutdown keeps
            // this process alive, and its extension socket would stay connected to a
            // host nobody serves.
            upgraded.destroy();
        }
        this.upgraded.clear();
        await new Promise(resolve => {
            this.server.close(() => resolve());
            // Keep-alive sockets would otherwise hold the close callback; upgraded
            // sockets are already detached from the server's connection tracking.
            this.server.closeAllConnections();
        });
    }
    dispatchHttp(req, res) {
        const path = requestPath(req);
        const handler = path === undefined ? undefined : this.httpRoutes.get(path);
        if (handler === undefined) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end('{"ok":false,"error":"not found"}');
            return;
        }
        const failed = () => {
            if (res.headersSent) {
                res.destroy();
                return;
            }
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end('{"ok":false,"error":"bridge route failed"}');
        };
        try {
            void Promise.resolve(handler(req, res)).catch(failed);
        }
        catch {
            // A handler that throws before returning a promise rejects nothing.
            failed();
        }
    }
    dispatchUpgrade(req, socket, head) {
        const path = requestPath(req);
        const handler = path === undefined ? undefined : this.upgradeRoutes.get(path);
        if (handler === undefined) {
            socket.destroy();
            return;
        }
        try {
            void Promise.resolve(handler(req, socket, head)).catch(() => socket.destroy());
        }
        catch {
            socket.destroy();
        }
    }
}
/** The request pathname, ignoring the query; undefined when the URL cannot be parsed. */
function requestPath(req) {
    try {
        return new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=local-server.js.map