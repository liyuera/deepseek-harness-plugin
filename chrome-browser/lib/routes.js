/**
 * Same-origin HTTP routes the browser half calls: list tabs, bind one tab to
 * a session, read the current binding, plus the extension-bridge WebSocket
 * upgrade and its status endpoint. Static client bundles have no
 * package-private RPC channel (host.call is a dynamic-plugin builtin), so the
 * client half reaches the host through these routes.
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
/** Read and parse one JSON request body. */
async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        return typeof value === 'object' && value !== null ? value : undefined;
    }
    catch {
        return undefined;
    }
}
/** Validate one select body: a session id plus any non-empty tab-id selection. */
export function parseSelectBody(body) {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    let tabIds = [];
    if (Array.isArray(body.tabIds)) {
        tabIds = body.tabIds.filter((id) => typeof id === 'string' && id !== '');
    }
    else if (typeof body.tabId === 'string' && body.tabId !== '') {
        tabIds = [body.tabId];
    }
    if (sessionId === '' || tabIds.length === 0)
        return undefined;
    // deduplicate while preserving selection order
    return { sessionId, tabIds: [...new Set(tabIds)] };
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
/**
 * Register the plugin's browser-half routes and the extension bridge upgrade.
 * All answered ok/error shaped so the client only needs one answer type.
 * @param ctx - Cordis context (webServer read through ctx.get).
 * @param backend - the live browser backend.
 * @param bindings - the session tab binding store.
 */
export function registerChromeRoutes(ctx, backend, bindings, screenshotDir) {
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
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/chrome-browser/ext/upload',
        handler: async (req, res) => {
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
        },
    }), 'chrome-browser: screenshot upload route');
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/chrome-browser/ext/trace',
        handler: async (req, res) => {
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
        },
    }), 'chrome-browser: bridge trace route');
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/chrome-browser/select',
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                writeJson(res, 405, { ok: false, error: 'method not allowed' });
                return;
            }
            const body = await readJsonBody(req);
            if (body === undefined) {
                writeJson(res, 400, { ok: false, error: 'invalid JSON body' });
                return;
            }
            const parsed = parseSelectBody(body);
            if (parsed === undefined) {
                writeJson(res, 400, { ok: false, error: 'sessionId and a non-empty tabId/tabIds selection are required' });
                return;
            }
            try {
                const tabs = await backend.listTabs();
                const byId = new Map(tabs.map(tab => [tab.id, tab]));
                const picked = parsed.tabIds
                    .map(tabId => byId.get(tabId))
                    .filter((tab) => tab !== undefined);
                if (picked.length !== parsed.tabIds.length) {
                    writeJson(res, 200, { ok: false, error: 'one or more tab ids were not found in Chrome; list tabs first' });
                    return;
                }
                bindings.set(parsed.sessionId, picked.map(tab => tab.id));
                writeJson(res, 200, { ok: true, tab: picked[0], tabs: picked });
            }
            catch (error) {
                writeJson(res, 200, {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        },
    }), 'chrome-browser: select route');
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/chrome-browser/state',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                writeJson(res, 405, { ok: false, error: 'method not allowed' });
                return;
            }
            const url = new URL(req.url ?? '/', 'http://dsh.internal');
            const sessionId = url.searchParams.get('sessionId') ?? '';
            const tabId = bindings.get(sessionId);
            let title = '';
            let urlValue = '';
            let favicon = '';
            if (tabId !== undefined) {
                try {
                    const tab = (await backend.listTabs()).find(candidate => candidate.id === tabId);
                    if (tab !== undefined) {
                        title = tab.title;
                        urlValue = tab.url;
                        favicon = tab.favicon;
                    }
                }
                catch {
                    // The browser is not connected; the binding itself stays.
                }
            }
            writeJson(res, 200, {
                ok: true,
                selected: tabId === undefined ? null : {
                    tabId,
                    tabIds: bindings.all(sessionId),
                    title,
                    url: urlValue,
                    favicon,
                },
            });
        },
    }), 'chrome-browser: state route');
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/chrome-browser/ext/status',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                writeJson(res, 405, { ok: false, error: 'method not allowed' });
                return;
            }
            writeJson(res, 200, {
                ok: true,
                backend: backend instanceof ExtensionBackend ? 'extension' : 'cdp',
                connected: backend instanceof ExtensionBackend ? backend.isConnected() : true,
            });
        },
    }), 'chrome-browser: extension status route');
    // The extension ships inside this package; an npm install leaves it beside
    // the built host half, so the bridge's own server hands it out as a zip the
    // user unpacks and loads from chrome://extensions.
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/chrome-browser/extension.zip',
        handler: (req, res) => {
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
        },
    }), 'chrome-browser: extension download route');
    ctx.effect(() => webServer.registerUpgrade({
        path: '/chrome-browser/ext/ws',
        handler: upgradeHandler(backend),
    }), 'chrome-browser: extension bridge upgrade');
}
//# sourceMappingURL=routes.js.map