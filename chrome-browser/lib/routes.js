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
import { ExtensionBackend } from "./backend.js";
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createExtensionZip, extensionDir } from "./extension-package.js";
import { wsHandshake } from "./ws.js";
/** JSON response writer. */
export function writeJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
}
/** The extension-bridge WS upgrade handler (handshake + attach). */
function upgradeHandler(backend) {
    return (req, socket, head) => {
        if (!(backend instanceof ExtensionBackend)) {
            socket.destroy();
            return;
        }
        if (!wsHandshake(req, socket))
            return;
        backend.attach(socket, head);
        socket.on('close', () => backend.detach());
    };
}
/** Screenshot upload the extension posts when it captured through its own channel. */
function uploadHandler(screenshotDir) {
    return async (req, res) => {
        if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
        }
        const chunks = [];
        for await (const chunk of req)
            chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        if (buffer.length === 0) {
            writeJson(res, 200, { ok: false, error: 'empty upload body' });
            return;
        }
        if (buffer.length > 32 * 1024 * 1024) {
            writeJson(res, 200, { ok: false, error: 'upload too large (32MB cap)' });
            return;
        }
        const path = join(screenshotDir, `upload-${Date.now()}.jpg`);
        mkdirSync(dirname(path), { recursive: true });
        try {
            writeFileSync(path, buffer);
        }
        catch (error) {
            writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
            return;
        }
        writeJson(res, 200, { ok: true, path });
    };
}
/** The extension's persisted worker trace (diagnostics). */
function traceHandler(backend) {
    return async (req, res) => {
        if (req.method !== 'GET') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
        }
        try {
            const traceable = backend;
            if (typeof traceable.trace !== 'function') {
                writeJson(res, 200, { ok: false, error: 'backend has no trace channel' });
                return;
            }
            const url = new URL(req.url ?? '/', 'http://localhost');
            const rows = await traceable.trace(url.searchParams.get('clear') === '1');
            writeJson(res, 200, { ok: true, trace: rows });
        }
        catch (error) {
            writeJson(res, 200, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    };
}
/** Bridge attachment, extension build, and fixed-port bridge state. */
function statusHandler(backend, bridge) {
    return (req, res) => {
        if (req.method !== 'GET') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
        }
        writeJson(res, 200, {
            ok: true,
            backend: backend instanceof ExtensionBackend ? 'extension' : 'cdp',
            connected: backend instanceof ExtensionBackend ? backend.isConnected() : true,
            // A stale extension is the one failure the user can fix in one click,
            // and nothing else surfaces it: every tool would fail as if the plugin
            // were broken.
            ...(backend instanceof ExtensionBackend ? backend.extensionStatus() : {}),
            ...(backend instanceof ExtensionBackend && bridge !== undefined ? { bridge } : {}),
        });
    };
}
/** The bundled extension as a zip; the user unpacks and loads it from chrome://extensions. */
function extensionDownloadHandler() {
    return (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
        }
        let archive;
        try {
            archive = createExtensionZip(extensionDir(import.meta.url));
        }
        catch (error) {
            writeJson(res, 500, { ok: false, error: `extension package unavailable: ${String(error)}` });
            return;
        }
        res.writeHead(200, {
            'content-type': 'application/zip',
            'content-length': String(archive.length),
            'content-disposition': 'attachment; filename="dsh-chrome-browser-extension.zip"',
        });
        res.end(req.method === 'HEAD' ? undefined : archive);
    };
}
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
export function registerExtensionRoutes(carrier, backend, screenshotDir, bridge) {
    const disposers = [
        carrier.register({
            kind: 'exact',
            path: '/chrome-browser/ext/upload',
            handler: uploadHandler(screenshotDir),
        }),
        carrier.register({
            kind: 'exact',
            path: '/chrome-browser/ext/trace',
            handler: traceHandler(backend),
        }),
        carrier.register({
            kind: 'exact',
            path: '/chrome-browser/ext/status',
            handler: statusHandler(backend, bridge),
        }),
        carrier.register({
            kind: 'exact',
            path: '/chrome-browser/extension.zip',
            handler: extensionDownloadHandler(),
        }),
        carrier.registerUpgrade({
            path: '/chrome-browser/ext/ws',
            handler: upgradeHandler(backend),
        }),
    ];
    return () => {
        for (const dispose of disposers)
            dispose();
    };
}
/**
 * Register the plugin's browser-half routes and the extension bridge.
 * All answered ok/error shaped so the client only needs one answer type.
 * @param ctx - Cordis context (webServer read through ctx.get).
 * @param backend - the live browser backend.
 * @param screenshotDir - directory uploads are written to.
 * @param activity - the in-flight call tracker the status strip reads.
 * @param bridge - fixed-port bridge state reported by the extension status route.
 */
export function registerChromeRoutes(ctx, backend, screenshotDir, activity, bridge) {
    const webServer = ctx.get('webServer');
    if (webServer === undefined)
        return;
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/chrome-browser/tabs',
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                writeJson(res, 405, { ok: false, error: 'method not allowed' });
                return;
            }
            try {
                const tabs = await backend.listTabs();
                writeJson(res, 200, { ok: true, tabs });
            }
            catch (error) {
                writeJson(res, 200, {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        },
    }), 'chrome-browser: tabs route');
    // The browser half polls this while a session view is open, and renders one
    // chip in the Session header from it. The route owns the facts a chip needs
    // besides the call itself: whether the bridge is attached at all, and whether
    // the extension is running older files than this plugin ships — the two
    // conditions a user can only fix themselves, and the two no tool call
    // reports, because a disconnected bridge answers nothing at all.
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/chrome-browser/activity',
        handler: (req, res) => {
            if (req.method !== 'GET') {
                writeJson(res, 405, { ok: false, error: 'method not allowed' });
                return;
            }
            const url = new URL(req.url ?? '/', 'http://dsh.internal');
            const sessionId = url.searchParams.get('sessionId') ?? '';
            const link = backend instanceof ExtensionBackend
                ? { connected: backend.isConnected(), stale: backend.extensionStatus().stale }
                : { connected: true, stale: false };
            writeJson(res, 200, {
                ok: true,
                ...link,
                ...activity.snapshot(sessionId === '' ? undefined : sessionId),
            });
        },
    }), 'chrome-browser: activity route');
    ctx.effect(() => registerExtensionRoutes(webServer, backend, screenshotDir, bridge), 'chrome-browser: extension routes');
}
//# sourceMappingURL=routes.js.map