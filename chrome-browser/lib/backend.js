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
import { consoleMessageFrom } from "./console-events.js";
import { clickExpression, focusAndSelectExpression, focusExpression, hoverExpression, inventoryExpression, pressExpression, readPageExpression, readyStateExpression, selectExpression, waitExpression, webmcpCallExpression, webmcpListExpression, } from "./expressions.js";
import { Chrome } from "./chrome.js";
import { WsConnection, wsHandshake } from "./ws.js";
import { pageSizeExpression, rectExpression } from "./expressions.js";
import { extensionStamp, extensionVersion } from "./extension-package.js";
/**
 * Longest edge a capture may produce, in device pixels.
 *
 * A page can be far taller than this, and a texture beyond the GPU's limit
 * makes the capture fail outright rather than downscale it. Width follows the
 * scale, so the aspect ratio stays the page's.
 */
const MAX_CAPTURE_PX = 16_000;
/** Read one untrusted value as a plain record, or undefined. */
function recordOf(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
/**
 * Map a WebMCP listing envelope from either backend onto {@link WebMcpTools}.
 * @param value - the `__dshWebmcp` envelope.
 * @returns the listing, with unreadable rows dropped.
 */
export function mapWebMcpTools(value) {
    const envelope = recordOf(value);
    if (envelope === undefined || envelope.__dshWebmcp !== 1)
        throw new Error('WebMCP 列表应答格式无法识别');
    if (envelope.available !== true) {
        return {
            available: false,
            reason: typeof envelope.reason === 'string' && envelope.reason !== '' ? envelope.reason : '该页面没有可用的 WebMCP 工具',
            tools: [],
        };
    }
    const rows = Array.isArray(envelope.tools) ? envelope.tools : [];
    return {
        available: true,
        tools: rows.flatMap((row) => {
            const tool = recordOf(row);
            if (tool === undefined || typeof tool.name !== 'string' || tool.name === '')
                return [];
            return [{
                    name: tool.name,
                    title: typeof tool.title === 'string' ? tool.title : '',
                    description: typeof tool.description === 'string' ? tool.description : '',
                    origin: typeof tool.origin === 'string' ? tool.origin : '',
                    inputSchema: tool.inputSchema === undefined ? null : tool.inputSchema,
                    annotations: recordOf(tool.annotations) ?? {},
                }];
        }),
    };
}
/**
 * Map a WebMCP invocation envelope from either backend onto
 * {@link WebMcpCallOutcome}; a page-reported failure becomes a thrown error so
 * the model sees the reason and can pick another tool.
 * @param value - the `__dshWebmcp` envelope.
 * @returns the outcome.
 */
export function mapWebMcpCall(value) {
    const envelope = recordOf(value);
    if (envelope === undefined || envelope.__dshWebmcp !== 1)
        throw new Error('WebMCP 调用应答格式无法识别');
    if (envelope.ok !== true) {
        throw new Error(typeof envelope.error === 'string' && envelope.error !== '' ? envelope.error : 'WebMCP 工具调用失败');
    }
    const tool = typeof envelope.tool === 'string' ? envelope.tool : '';
    if (envelope.pending === true) {
        return {
            tool,
            pending: true,
            ...(typeof envelope.note === 'string' && envelope.note !== '' ? { note: envelope.note } : {}),
        };
    }
    if (envelope.navigated === true)
        return { tool, navigated: true };
    return { tool, result: envelope.result };
}
/** Shared sleep. */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
/** Map one extension tab row to the backend face. */
function mapExtTab(tab) {
    return {
        id: String(tab.id ?? ''),
        title: tab.title ?? '',
        url: tab.url ?? '',
        active: tab.active === true,
        favicon: tab.favicon ?? '',
    };
}
/**
 * Poll one tab's `document.readyState` until it reports `complete` or the bound
 * elapses. Reaching the bound is not an error: a page that never settles (a
 * long-polling app, a stalled asset) must still hand control back to the model,
 * which can read what is there and decide what to do.
 * @param evaluate - runs one expression in the tab.
 * @param waitLoadMs - the bound; zero or less returns immediately.
 */
async function awaitReady(evaluate, waitLoadMs) {
    if (waitLoadMs <= 0)
        return;
    const deadline = Date.now() + waitLoadMs;
    while (Date.now() < deadline) {
        if (await evaluate(readyStateExpression()) === 'complete')
            return;
        await sleep(300);
    }
}
/** Poll interval for `waitFor`, milliseconds. */
const WAIT_POLL_MS = 100;
/**
 * Poll one boolean expression until it answers true or the bound elapses. It is
 * always evaluated at least once, so a zero bound asks "does it hold now?".
 * @param evaluate - runs one expression in the tab.
 * @param expression - the condition to poll.
 * @param timeoutMs - the bound.
 * @returns whether the condition held before the bound passed.
 */
async function awaitTruthy(evaluate, expression, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await evaluate(expression) === true)
            return true;
        if (Date.now() >= deadline)
            return false;
        await sleep(WAIT_POLL_MS);
    }
}
/** Read a hover result from the page or the bridge. */
export function mapHover(value) {
    if (typeof value !== 'object' || value === null)
        return { matched: 0, hovered: false };
    const source = value;
    return { matched: counter(source, 'matched'), hovered: source.hovered === true };
}
/** Read a press result from the page or the bridge. */
export function mapPress(value) {
    if (typeof value !== 'object' || value === null)
        return { found: false, pressed: false, submitted: false };
    const source = value;
    return {
        found: flag(source, 'found'),
        pressed: flag(source, 'pressed'),
        submitted: flag(source, 'submitted'),
    };
}
/** Read a select result from the page or the bridge. */
export function mapSelect(value) {
    if (typeof value !== 'object' || value === null) {
        return { matched: 0, changed: false, value: '', options: [] };
    }
    const source = value;
    const reason = typeof source.reason === 'string' && source.reason !== '' ? source.reason : undefined;
    return {
        matched: counter(source, 'matched'),
        changed: flag(source, 'changed'),
        value: typeof source.value === 'string' ? source.value : '',
        options: Array.isArray(source.options)
            ? source.options.filter((option) => typeof option === 'string')
            : [],
        ...(reason === undefined ? {} : { reason }),
    };
}
/**
 * The error a side-effectful command produces when it was sent and no outcome
 * came back — a disconnect, a timeout, or a bridge that gave up mid-operation.
 *
 * The distinction matters to the model: a command that FAILED is safe to retry,
 * while a command whose outcome is UNKNOWN is not. A re-sent click is a second
 * click and a re-sent type is a second insertion, so the message says what to do
 * instead. Commands in `SAFE_RETRY_OPS` never reach this: they are side-effect
 * free and replay on reconnect.
 * @param op - the operation whose outcome is unknown, when it is known.
 * @param cause - what went wrong, for whoever reads the transcript.
 * @returns the error to reject the command with.
 */
function unknownOutcome(op, cause) {
    return new Error(`${op ?? '命令'} 结果未知(${cause}):命令已发出但没有收到执行结果,页面可能已经改变。`
        + '不要直接重试,先用 chrome_tabs / chrome_read 确认页面当前状态。');
}
/** Read one click counter from an untrusted result, treating anything else as absent. */
function counter(source, key) {
    const value = source[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
/**
 * Map a click result onto {@link ClickOutcome}. A bare number is accepted as the
 * pre-0.4 bridge's "matched and clicked" count, so a Chrome extension still
 * loaded from an older package keeps working until it is reloaded.
 * @param value - the evaluated page value or the bridge's reply payload.
 * @returns the outcome, with every field defaulted.
 */
export function mapClickOutcome(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return { matched: value, clicked: value, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0 };
    }
    if (typeof value !== 'object' || value === null) {
        return { matched: 0, clicked: 0, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0 };
    }
    const source = value;
    return {
        matched: counter(source, 'matched'),
        clicked: counter(source, 'clicked'),
        disabled: counter(source, 'disabled'),
        invisible: counter(source, 'invisible'),
        offscreen: counter(source, 'offscreen'),
        covered: counter(source, 'covered'),
        ariaDisabled: counter(source, 'ariaDisabled'),
    };
}
/** Read one boolean field, treating anything but `true` as false. */
function flag(source, key) {
    return source[key] === true;
}
/**
 * Map an inventory result from the page or the bridge onto
 * {@link BackendInventory}. An unusable reply becomes an empty inventory rather
 * than an error: the caller asked what it can act on, and "nothing reported" is
 * a truthful answer for a page that would not answer.
 * @param value - the evaluated page value or the bridge's reply payload.
 * @returns the inventory, with unreadable entries dropped.
 */
export function mapInventory(value) {
    if (typeof value !== 'object' || value === null)
        return { title: '', url: '', matched: 0, items: [] };
    const source = value;
    const raw = Array.isArray(source.items) ? source.items : [];
    const items = [];
    for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null)
            continue;
        const item = entry;
        const selector = typeof item.selector === 'string' ? item.selector : '';
        if (selector === '')
            continue;
        items.push({
            selector,
            role: typeof item.role === 'string' ? item.role : '',
            name: typeof item.name === 'string' ? item.name : '',
            inView: flag(item, 'inView'),
            disabled: flag(item, 'disabled'),
            covered: flag(item, 'covered'),
        });
    }
    return {
        title: typeof source.title === 'string' ? source.title : '',
        url: typeof source.url === 'string' ? source.url : '',
        matched: counter(source, 'matched'),
        items,
    };
}
/**
 * Extension bridge backend: commands are queued, sent over the bridge
 * WebSocket, and resolved when the extension replies. The socket is attached
 * by the `/chrome-browser/ext/ws` upgrade route.
 */
export class ExtensionBackend {
    config;
    onConsole;
    /** @inheritdoc BrowserBackend.lastEvalWorld */
    lastEvalWorld = undefined;
    /**
     * Ops a disconnect may transparently retry on the next reconnect: they are
     * side-effect free or idempotent, so a lost result is safe to recompute.
     * Side-effectful ops (open/navigate/click/type) are NEVER auto-resent — the
     * caller gets the disconnect error and the model retries explicitly (no
     * duplicate tabs/clicks/typing from hidden replays). Console capture is
     * idempotent and the extension re-arms it on reconnect, so retrying it is
     * how a restarted service worker gets its capture back.
     */
    static SAFE_RETRY_OPS = new Set([
        'list-tabs', 'read', 'eval', 'screenshot', 'console-start', 'console-stop', 'webmcp-list',
    ]);
    /**
     * In-flight dedupe keys for side-effectful ops: a second identical command
     * while the first is still in flight JOIN it instead of firing twice
     * (model retries can otherwise double-click / double-open).
     */
    inFlight = new Map();
    conn = null;
    /** What the extension last said about itself; null before its first hello. */
    extension = null;
    /**
     * The stale build stamp an automatic reload was last asked for, or null.
     *
     * Keyed by stamp rather than by attempt: a reload that cannot move the
     * extension off one build must never be asked for twice — that would reload
     * it on every heartbeat — while a mismatch at a *different* build is a
     * different problem and deserves its own attempt, so two upgrades within one
     * host process both settle.
     */
    reloadAskedFor = null;
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
    reloadIneffective = false;
    seq = 0;
    unacked = new Map();
    /**
     * `deadline` is an ABSOLUTE cap per command (push + 2x timeout): reconnect
     * grace may never extend a command's total lifetime, or a flapping bridge
     * (detach → resend → detach…) would keep it alive indefinitely.
     */
    pending = new Map();
    pingTimer = null;
    /** Where console messages from the bridge land. */
    constructor(config, onConsole = () => { }) {
        this.config = config;
        this.onConsole = onConsole;
    }
    /** The WS upgrade route calls this after a successful handshake. */
    attach(socket, head) {
        // A reconnecting client may attach while another (stale) socket is still
        // registered; replace it without leaking the previous connection.
        if (this.conn !== null)
            this.conn.close();
        const conn = new WsConnection(socket, head);
        this.conn = conn;
        conn.onMessage(text => this.onFrame(text));
        this.flush();
        if (this.pingTimer === null) {
            // Two keep-alives: the protocol-level ping (network stack, no JS) and a
            // JSON ping the service worker's onmessage executes — JS activity every
            // 10s prevents Chrome from suspending the MV3 worker mid-bridge.
            this.pingTimer = setInterval(() => {
                // Read the LIVE connection each tick: the first attach's `conn` goes
                // stale after any reconnect, and keep-alives aimed at a dead socket
                // let Chrome suspend the worker mid-command (tabs/eval survive the
                // alarm-wake window, long ops like screenshot die).
                const current = this.conn;
                if (current !== null) {
                    current.ping();
                    current.send(JSON.stringify({ kind: 'ping' }));
                }
            }, 10000);
            this.pingTimer.unref();
        }
    }
    detach() {
        if (this.pingTimer !== null) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        const settled = new Set();
        for (const [seq, entry] of this.pending) {
            const op = this.unacked.get(seq)?.op;
            if (op !== undefined && ExtensionBackend.SAFE_RETRY_OPS.has(op)) {
                // Side-effect free: keep it queued and give the bridge the REMAINDER
                // of the command's absolute deadline before giving up; `attach`
                // re-sends. Repeated disconnects can never extend the deadline.
                const remaining = entry.deadline - Date.now();
                if (remaining <= 0) {
                    clearTimeout(entry.timer);
                    entry.reject(new Error('Chrome 扩展重连超时,请确认扩展已加载'));
                    this.pending.delete(seq);
                    this.unacked.delete(seq);
                    continue;
                }
                clearTimeout(entry.timer);
                entry.timer = setTimeout(() => {
                    if (!this.pending.delete(seq))
                        return;
                    this.unacked.delete(seq);
                    entry.reject(new Error('Chrome 扩展重连超时,请确认扩展已加载'));
                }, remaining);
                entry.timer.unref();
                continue;
            }
            // Unsafe (or unknown) op: dead on disconnect — never replayed, since a
            // re-sent `open` would open another tab and `type`/`click`/`navigate`
            // would repeat their side effects.
            clearTimeout(entry.timer);
            entry.reject(unknownOutcome(op, 'Chrome 扩展已断开连接'));
            settled.add(seq);
            this.pending.delete(seq);
            this.unacked.delete(seq);
        }
        this.conn = null;
    }
    /** Whether the extension bridge is currently attached. */
    isConnected() {
        return this.conn !== null;
    }
    /** Read (or clear) the extension's persisted worker trace (diagnostics). */
    async trace(clear = false) {
        return this.push('trace', { clear });
    }
    async ensure() {
        const deadline = Date.now() + this.config.timeoutMs;
        while (this.conn === null) {
            if (Date.now() > deadline) {
                throw new Error('Chrome 扩展未连接:请在 chrome://extensions 打开「开发者模式」→「加载已解压的扩展程序」,'
                    + `选择插件目录下的 extension/ 文件夹,然后确认连接成功。当前配置 backend: extension(端口 ${this.config.port} 对应 dsh web 地址)。`);
            }
            await sleep(100);
        }
    }
    async activeTabId() {
        const tabs = await this.listTabs();
        const active = tabs.find(tab => tab.active) ?? tabs[0];
        if (active === undefined)
            throw new Error('no Chrome tab available; open one with chrome_open');
        return active.id;
    }
    async listTabs() {
        const result = await this.push('list-tabs', {});
        return (result?.tabs ?? []).map(mapExtTab);
    }
    async openTab(url) {
        // Idempotence guard: a retried `open` for a URL already on a tab must not
        // multiply tabs (models retry on timeout). Reuse the existing tab instead.
        if (url !== '' && url !== 'about:blank') {
            const tabs = await this.listTabs();
            const existing = tabs.find(tab => tab.url === url && tab.url !== '');
            if (existing !== undefined)
                return existing;
        }
        const result = await this.push('open', { url: url ?? 'about:blank' });
        return mapExtTab(result);
    }
    async read(tabId, includeHtml) {
        const result = await this.push('read', { tabId, includeHtml });
        return {
            title: typeof result?.title === 'string' ? result.title : '',
            url: typeof result?.url === 'string' ? result.url : '',
            text: typeof result?.text === 'string' ? result.text : '',
            html: typeof result?.html === 'string' ? result.html : '',
        };
    }
    async inventory(tabId) {
        return mapInventory(await this.push('inventory', { tabId }));
    }
    async closeTab(tabId) {
        await this.push('close', { tabId });
    }
    async navigate(tabId, url, waitLoad, waitLoadMs) {
        await this.push('navigate', { tabId, url });
        if (waitLoad)
            await this.waitForLoad(tabId, waitLoadMs);
    }
    async waitForLoad(tabId, waitLoadMs) {
        await awaitReady(expression => this.evaluate(tabId, expression), waitLoadMs);
    }
    async evaluate(tabId, expression) {
        const answer = await this.push('eval', { tabId, expression });
        // An extension built before this envelope answers with the bare value; a
        // current one tags it. The tag is what keeps an expression that legitimately
        // returns `{ ok, value }` from being read as an envelope.
        if (typeof answer !== 'object' || answer === null || answer.__dshEval !== 1) {
            this.lastEvalWorld = undefined;
            return answer;
        }
        const envelope = answer;
        if (envelope.ok !== true) {
            this.lastEvalWorld = undefined;
            throw new Error(typeof envelope.error === 'string' && envelope.error !== ''
                ? `chrome_eval: ${envelope.error}`
                : 'chrome_eval: 表达式执行失败');
        }
        this.lastEvalWorld = envelope.world === 'debugger' ? 'debugger' : 'main';
        return envelope.value;
    }
    async webmcpTools(tabId) {
        return mapWebMcpTools(await this.push('webmcp-list', { tabId }));
    }
    async webmcpCall(tabId, name, input) {
        // Arguments are sent as one object: the page's `executeTool(tool, input)`
        // takes a single JSON-serializable value, never a spread argument list.
        return mapWebMcpCall(await this.push('webmcp-call', { tabId, name, input }));
    }
    async click(tabId, selector, all) {
        return mapClickOutcome(await this.push('click', { tabId, selector, all }));
    }
    async hover(tabId, selector) {
        return mapHover(await this.push('hover', { tabId, selector }));
    }
    async press(tabId, key, selector) {
        return mapPress(await this.push('press', selector === undefined
            ? { tabId, key }
            : { tabId, key, selector }));
    }
    async select(tabId, selector, value) {
        return mapSelect(await this.push('select', { tabId, selector, value }));
    }
    async waitFor(tabId, selector, state, timeoutMs) {
        return awaitTruthy(expression => this.evaluate(tabId, expression), waitExpression(selector, state), timeoutMs);
    }
    async type(tabId, selector, text, clear) {
        const done = await this.push('type', { tabId, selector, text, clear });
        if (done !== true)
            throw new Error(`chrome_type: no element matched selector "${selector}"`);
    }
    async screenshot(tabId, options) {
        // The extension uploads the image bytes over plain HTTP back to the host
        // and returns only the file path: a large base64 frame inside a WS JSON
        // message closed the bridge right after a successful capture.
        const result = await this.push('screenshot', {
            tabId,
            fullPage: options?.fullPage === true,
            ...(options?.selector === undefined ? {} : { selector: options.selector }),
        });
        if (result?.path === undefined)
            return { data: '' };
        const outcome = { data: '', path: result.path };
        if (result.mime !== undefined)
            outcome.mime = result.mime;
        // Absent on the normal route. Present when the debugger capture failed and
        // the visible-window capture had to stand in for it.
        if (result.fallback === 'visible-tab') {
            outcome.fallback = 'visible-tab';
            if (result.viewportOnly === true)
                outcome.viewportOnly = true;
            if (typeof result.reason === 'string' && result.reason !== '')
                outcome.fallbackReason = result.reason;
        }
        return outcome;
    }
    async startConsole(tabId) {
        // The extension attaches its debugger and forwards events; it also persists
        // the capture set, so a service worker that Chrome suspends re-arms it.
        await this.push('console-start', { tabId });
    }
    async stopConsole(tabId) {
        await this.push('console-stop', { tabId });
    }
    dispose() {
        this.detach();
        this.conn?.close();
    }
    /**
     * What the connected extension reports about itself, for the status route.
     * `stale` means its files are older than the ones this package ships, which
     * only a reload of the extension can fix.
     */
    extensionStatus() {
        const expectedBuild = extensionStamp(import.meta.url);
        const build = this.extension?.build ?? '';
        return {
            version: this.extension?.version ?? '',
            expectedVersion: extensionVersion(import.meta.url),
            build,
            expectedBuild,
            // The stamp decides. It is baked into the worker, so it describes the
            // code Chrome loaded — a version number nobody bumped would not.
            stale: build !== '' && expectedBuild !== '' && build !== expectedBuild,
            autoReloadAsked: this.reloadAskedFor !== null,
            // The two facts that decide whether an automatic update can still happen:
            // which stamp was already asked about, and whether the extension even
            // advertises the op that performs it. Both are here because a stalled
            // update is otherwise indistinguishable from a reload that did not help.
            reloadAskedFor: this.reloadAskedFor ?? '',
            reloadIneffective: this.reloadIneffective,
            ops: (this.extension?.ops ?? []).join(','),
        };
    }
    /**
     * Record the extension's self-report, and ask it to reload when it is running
     * older files than this package ships.
     *
     * Chrome never re-reads an unpacked extension's files, so an upgraded plugin
     * would otherwise keep driving a stale bridge until the user reloaded it by
     * hand. `chrome.runtime.reload()` is the only thing that re-reads them.
     */
    noteExtensionHello(message) {
        const version = typeof message.version === 'string' ? message.version : '';
        const build = typeof message.build === 'string' ? message.build : '';
        const ops = Array.isArray(message.ops)
            ? message.ops.filter((op) => typeof op === 'string')
            : [];
        this.extension = { version, ops, build };
        const expected = extensionStamp(import.meta.url);
        if (build === '' || expected === '' || build === expected) {
            this.reloadIneffective = false;
            return;
        }
        if (!ops.includes('reload'))
            return;
        if (this.reloadAskedFor === build) {
            // Asked about this exact build and it is still what the extension runs.
            this.reloadIneffective = true;
            return;
        }
        this.reloadIneffective = false;
        // The attempt is spent only once the request is on the wire. Marking it
        // first made a request that never went out — refused by the capability
        // check, or lost with the socket — indistinguishable from a reload that
        // ran and did not help, and the extension was then never asked again.
        // Carries the stamp it is asked about, which is what makes two requests
        // distinct to the in-flight dedupe rather than one request twice.
        void this.push('reload', { build }).then(() => { this.reloadAskedFor = build; }, () => undefined);
    }
    /**
     * Refuse an op the connected extension does not advertise.
     *
     * Sending it anyway earns `unknown op` back — an internal error that says
     * nothing about the real cause, which is an extension whose files are older
     * than the plugin driving it.
     */
    assertExtensionSupports(op) {
        const known = this.extension?.ops;
        if (known === undefined || known.length === 0)
            return;
        if (known.includes(op))
            return;
        throw new Error(`扩展不支持 ${op}(它自报的版本是 ${this.extension?.version ?? '未知'},插件期望 `
            + `${extensionVersion(import.meta.url)})——扩展文件比插件旧,请在 chrome://extensions 重新加载该扩展。`);
    }
    push(op, args) {
        this.assertExtensionSupports(op);
        // Concurrent duplicate of a side-effectful command joins the in-flight
        // one (model retries double-clicking / double-opening otherwise).
        //
        // Keyed on every argument, not just the target: two waits on one selector
        // differ by state and deadline, and two reloads differ by the version they
        // are stale at. Merging those would answer the second call with the first
        // call's result. Ops absent from SAFE_RETRY_OPS are never replayed across a
        // reconnect, so replaying a reload through that set would loop forever.
        const dedupeKey = ExtensionBackend.SAFE_RETRY_OPS.has(op) ? undefined
            : `${op}:${JSON.stringify(args)}`;
        if (dedupeKey !== undefined) {
            const existing = this.inFlight.get(dedupeKey);
            if (existing !== undefined)
                return existing;
        }
        const seq = ++this.seq;
        this.unacked.set(seq, { op, args });
        // A timeout means the extension never answered. For a side-effectful op the
        // command may still have run, so the caller gets the unknown-outcome error
        // rather than a plain failure it would retry.
        const sideEffectful = dedupeKey !== undefined;
        const outcome = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(seq);
                this.unacked.delete(seq);
                reject(sideEffectful
                    ? unknownOutcome(op, `Chrome 扩展 ${this.config.timeoutMs}ms 内未应答`)
                    : new Error(`Chrome 扩展 ${op} 超时(${this.config.timeoutMs}ms)`));
            }, this.config.timeoutMs);
            const deadline = Date.now() + this.config.timeoutMs * 2;
            this.pending.set(seq, { resolve, reject, timer, deadline });
        });
        if (dedupeKey !== undefined) {
            this.inFlight.set(dedupeKey, outcome);
            const cleanup = () => {
                if (this.inFlight.get(dedupeKey) === outcome)
                    this.inFlight.delete(dedupeKey);
            };
            // then(onFulfilled, onRejected): finally() would re-propagate the
            // rejection onto a voided promise and register an unhandled rejection.
            void outcome.then(cleanup, cleanup);
        }
        this.flush();
        return outcome;
    }
    onFrame(text) {
        let message;
        try {
            message = JSON.parse(text);
        }
        catch {
            return;
        }
        if (message.kind === 'event') {
            this.onEventFrame(message);
            return;
        }
        if (message.kind === 'hello') {
            this.noteExtensionHello(message);
            return;
        }
        if (message.kind !== 'results' || !Array.isArray(message.results))
            return;
        for (const entry of message.results) {
            const seq = Number(entry.seq);
            if (!Number.isInteger(seq))
                continue;
            const pending = this.pending.get(seq);
            if (pending === undefined)
                continue;
            this.pending.delete(seq);
            this.unacked.delete(seq);
            clearTimeout(pending.timer);
            if (entry.ok === true)
                pending.resolve(entry.data);
            else
                pending.reject(new Error(entry.error ?? 'Chrome 扩展执行失败'));
        }
    }
    /**
     * One pushed console batch. Anything unrecognized is dropped rather than
     * throwing: this is a wire boundary, and a malformed event must not kill the
     * connection that carries the commands.
     */
    onEventFrame(message) {
        if (message.event !== 'console')
            return;
        const tabId = message.tabId === undefined || message.tabId === null ? '' : String(message.tabId);
        if (tabId === '' || !Array.isArray(message.entries))
            return;
        for (const raw of message.entries) {
            if (typeof raw !== 'object' || raw === null)
                continue;
            const entry = raw;
            const text = typeof entry.text === 'string' ? entry.text : '';
            if (text === '')
                continue;
            const level = typeof entry.level === 'string' && entry.level !== '' ? entry.level : 'log';
            const source = typeof entry.source === 'string' && entry.source !== '' ? entry.source : undefined;
            this.onConsole(tabId, source === undefined ? { level, text } : { level, text, source });
        }
    }
    flush() {
        const conn = this.conn;
        if (conn === null)
            return;
        const commands = [...this.unacked.entries()].map(([seq, entry]) => ({ seq, ...entry }));
        if (commands.length > 0)
            conn.send(JSON.stringify({ kind: 'commands', commands }));
    }
}
/** CDP backend: the Chrome class plus per-tab endpoint operations. */
export class CdpBackend {
    onConsole;
    /** @inheritdoc BrowserBackend.lastEvalWorld */
    lastEvalWorld = undefined;
    chrome;
    /**
     * Long-lived sessions held open for console capture, one per capturing tab.
     * Every other operation opens and closes its own session; capture cannot,
     * because the events arrive between calls.
     */
    captures = new Map();
    constructor(chrome, onConsole = () => { }) {
        this.onConsole = onConsole;
        this.chrome = chrome;
    }
    async ensure() {
        await this.chrome.ensure();
    }
    async activeTabId() {
        const tabs = await this.listTabs();
        const tab = tabs.find(candidate => candidate.active) ?? tabs[0];
        if (tab === undefined)
            throw new Error('no Chrome tab available; open one with chrome_open');
        return tab.id;
    }
    async listTabs() {
        const tabs = await this.chrome.listTabsWithFavicons();
        return tabs.map(tab => ({ id: tab.id, title: tab.title, url: tab.url, active: tab.active, favicon: tab.favicon }));
    }
    async openTab(url) {
        // Same idempotence guard as the extension backend: reuse an existing tab
        // for the URL so retried opens do not multiply windows.
        if (url !== '' && url !== 'about:blank') {
            const tabs = await this.listTabs();
            const existing = tabs.find(tab => tab.url === url && tab.url !== '');
            if (existing !== undefined)
                return existing;
        }
        const tab = await this.chrome.openTab(url);
        return { ...tab, favicon: '' };
    }
    async read(tabId, includeHtml) {
        return this.withTab(tabId, async (endpoint) => {
            const value = await this.evaluatePage(endpoint, readPageExpression(includeHtml));
            return {
                title: typeof value?.title === 'string' ? value.title : '',
                url: typeof value?.url === 'string' ? value.url : '',
                text: typeof value?.text === 'string' ? value.text : '',
                html: typeof value?.html === 'string' ? value.html : '',
            };
        });
    }
    async inventory(tabId) {
        return this.withTab(tabId, async (endpoint) => (mapInventory(await this.evaluatePage(endpoint, inventoryExpression()))));
    }
    async closeTab(tabId) {
        await this.chrome.closeTab(tabId);
    }
    async navigate(tabId, url, waitLoad, waitLoadMs) {
        await this.withTab(tabId, async (endpoint) => {
            const result = await endpoint.call('Page.navigate', { url });
            const errorText = typeof result.errorText === 'string' ? result.errorText : undefined;
            if (errorText !== undefined)
                throw new Error(`chrome_navigate failed: ${errorText}`);
            if (waitLoad)
                await awaitReady(expression => this.evaluatePage(endpoint, expression), waitLoadMs);
        });
    }
    async waitForLoad(tabId, waitLoadMs) {
        // One CDP session for the whole wait, rather than one per poll.
        await this.withTab(tabId, endpoint => awaitReady(expression => this.evaluatePage(endpoint, expression), waitLoadMs));
    }
    async evaluate(tabId, expression) {
        // Runtime.evaluate is not subject to the page's CSP, so there is no second
        // world to fall back to.
        this.lastEvalWorld = 'main';
        return this.withTab(tabId, endpoint => this.evaluatePage(endpoint, expression));
    }
    async webmcpTools(tabId) {
        // Runtime.evaluate runs in the page's main world and awaits the expression's
        // promise, so the WebMCP surface is reachable without an extension.
        return mapWebMcpTools(await this.withTab(tabId, endpoint => this.evaluatePage(endpoint, webmcpListExpression())));
    }
    async webmcpCall(tabId, name, input) {
        return mapWebMcpCall(await this.withTab(tabId, endpoint => this.evaluatePage(endpoint, webmcpCallExpression(name, input))));
    }
    async click(tabId, selector, all) {
        return this.withTab(tabId, async (endpoint) => (mapClickOutcome(await this.evaluatePage(endpoint, clickExpression(selector, all)))));
    }
    async hover(tabId, selector) {
        return this.withTab(tabId, async (endpoint) => (mapHover(await this.evaluatePage(endpoint, hoverExpression(selector)))));
    }
    async press(tabId, key, selector) {
        return this.withTab(tabId, async (endpoint) => (mapPress(await this.evaluatePage(endpoint, pressExpression(key, selector)))));
    }
    async select(tabId, selector, value) {
        return this.withTab(tabId, async (endpoint) => (mapSelect(await this.evaluatePage(endpoint, selectExpression(selector, value)))));
    }
    async waitFor(tabId, selector, state, timeoutMs) {
        // One CDP session for the whole wait, rather than one per poll.
        return this.withTab(tabId, endpoint => (awaitTruthy(expression => this.evaluatePage(endpoint, expression), waitExpression(selector, state), timeoutMs)));
    }
    async type(tabId, selector, text, clear) {
        await this.withTab(tabId, async (endpoint) => {
            const focused = await this.evaluatePage(endpoint, clear ? focusAndSelectExpression(selector) : focusExpression(selector));
            if (focused !== true)
                throw new Error(`chrome_type: no element matched selector "${selector}"`);
            await endpoint.call('Input.insertText', { text });
        });
    }
    async screenshot(tabId, options) {
        return this.withTab(tabId, async (endpoint) => {
            const beyond = options?.fullPage === true || options?.selector !== undefined;
            const clip = options?.selector !== undefined
                ? await this.clipOf(endpoint, options.selector)
                : options?.fullPage === true ? await this.pageClipOf(endpoint) : undefined;
            const result = await endpoint.call('Page.captureScreenshot', {
                format: 'png',
                captureBeyondViewport: beyond,
                ...(clip === undefined ? {} : { clip }),
            });
            return { data: typeof result.data === 'string' ? result.data : '', mime: 'image/png' };
        });
    }
    /**
     * Clip rectangle covering the whole page, scaled down when it would not fit.
     *
     * Without a clip, `captureBeyondViewport` returns exactly one viewport — the
     * flag permits reaching past the fold, it does not ask for it.
     * @param endpoint - the tab's CDP endpoint.
     * @returns the clip rectangle, with the scale that keeps it capturable.
     */
    async pageClipOf(endpoint) {
        const size = await this.evaluatePage(endpoint, pageSizeExpression());
        const width = Number(size?.width);
        const height = Number(size?.height);
        if (!(width > 0) || !(height > 0))
            throw new Error('截图失败:读不到页面尺寸');
        const device = height * (Number(size?.dpr) || 1);
        return { x: 0, y: 0, width, height, scale: device > MAX_CAPTURE_PX ? MAX_CAPTURE_PX / device : 1 };
    }
    /**
     * One element's clip rectangle, or a failure naming the selector.
     * @param endpoint - the tab's CDP endpoint.
     * @param selector - CSS selector of the element to capture.
     * @returns the clip rectangle in page coordinates.
     */
    async clipOf(endpoint, selector) {
        const box = await this.evaluatePage(endpoint, rectExpression(selector));
        if (box?.matched !== 1)
            throw new Error(`截图失败:没有匹配 ${selector} 的元素`);
        const { x, y, width, height } = box;
        if (!(width > 0) || !(height > 0))
            throw new Error(`截图失败:${selector} 没有可见尺寸(宽 ${width} 高 ${height})`);
        return { x, y, width, height, scale: 1 };
    }
    async startConsole(tabId) {
        if (this.captures.has(tabId))
            return;
        const { endpoint } = await this.chrome.tabEndpoint(tabId, undefined);
        try {
            endpoint.onEvent((method, params) => {
                const message = consoleMessageFrom(method, params);
                if (message !== undefined)
                    this.onConsole(tabId, message);
            });
            // `Log.enable` also replays entries the browser buffered before it was
            // enabled, which is the closest thing to capturing from page load.
            await endpoint.call('Runtime.enable');
            await endpoint.call('Log.enable');
        }
        catch (error) {
            endpoint.close();
            throw error;
        }
        this.captures.set(tabId, endpoint);
    }
    async stopConsole(tabId) {
        const endpoint = this.captures.get(tabId);
        if (endpoint === undefined)
            return;
        this.captures.delete(tabId);
        endpoint.close();
    }
    dispose() {
        for (const endpoint of this.captures.values())
            endpoint.close();
        this.captures.clear();
        this.chrome.dispose();
    }
    async withTab(tabId, fn) {
        const { endpoint } = await this.chrome.tabEndpoint(tabId, undefined);
        try {
            return await fn(endpoint);
        }
        finally {
            endpoint.close();
        }
    }
    async evaluatePage(endpoint, expression) {
        const response = await endpoint.call('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
        });
        const details = response.exceptionDetails;
        if (typeof details === 'object' && details !== null) {
            const record = details;
            const text = typeof record.text === 'string' ? record.text : 'exception';
            const exception = record.exception;
            const description = typeof exception === 'object' && exception !== null
                && typeof exception.description === 'string'
                ? `: ${exception.description}`
                : '';
            throw new Error(`page evaluation failed${description} (${text})`);
        }
        const remote = response.result;
        return typeof remote === 'object' && remote !== null ? remote.value : undefined;
    }
}
/**
 * Build the configured backend.
 * @param config - the resolved plugin configuration.
 * @param onConsole - where captured console messages land.
 * @returns the backend, plus the `Chrome` instance the CDP path owns.
 */
export function buildBackend(config, onConsole = () => { }) {
    if (config.backend === 'cdp') {
        const chrome = new Chrome(config);
        return { backend: new CdpBackend(chrome, onConsole), chrome };
    }
    return { backend: new ExtensionBackend(config, onConsole) };
}
/** The WS upgrade handler the routes register: handshake then attach. */
export function extensionUpgradeHandler(backend) {
    return (req, socket, head) => {
        if (!(backend instanceof ExtensionBackend) || !wsHandshake(req, socket))
            return;
        backend.attach(socket, head);
        socket.on('close', () => backend.detach());
    };
}
//# sourceMappingURL=backend.js.map