/**
 * Minimal Chrome DevTools Protocol (CDP) client. Command framing, id
 * matching, timeouts, and teardown live here; the transport behind a
 * {@link CdpSocket} is injectable so framing logic is unit-testable without a
 * real WebSocket.
 * @module @liyuera/dsh-chrome-browser/cdp
 */
/** Race `promise` against a deadline; the loser's timer is always cleared. */
export async function withTimeout(promise, timeoutMs, message) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeout]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/**
 * Build a CDP endpoint over an injected socket. Each `call` sends one
 * `{ id, method, params }` frame and resolves on the matching `{ id, result }`
 * reply; CDP replies with `error` reject, and events (no numeric id) are
 * ignored. The call awaits the socket's `ready` before sending, so an
 * endpoint over a never-opening socket fails at the first command instead of
 * sending into the void.
 * @param socket - the opened (or opening) transport.
 * @param options - per-command timeout.
 * @returns the endpoint.
 */
export function cdpEndpoint(socket, options) {
    const pending = new Map();
    let nextId = 1;
    let closed = false;
    const listeners = new Set();
    const off = socket.onMessage((data) => {
        let message;
        try {
            message = JSON.parse(data);
        }
        catch {
            return;
        }
        if (typeof message.id !== 'number') {
            // An event: no id, a method name, and params. Commands and events share
            // the socket, so the id is what tells them apart.
            if (typeof message.method !== 'string')
                return;
            const params = typeof message.params === 'object' && message.params !== null
                ? message.params
                : {};
            for (const listener of listeners)
                listener(message.method, params);
            return;
        }
        const entry = pending.get(message.id);
        if (entry === undefined)
            return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error !== undefined) {
            const detail = typeof message.error.message === 'string' ? message.error.message : 'CDP error';
            const code = typeof message.error.code === 'number' ? ` (code ${message.error.code})` : '';
            entry.reject(new Error(`${detail}${code}`));
            return;
        }
        entry.resolve((message.result ?? {}));
    });
    return {
        async call(method, params = {}) {
            if (closed)
                throw new Error('CDP endpoint is closed');
            await withTimeout(socket.ready, options.timeoutMs, `CDP ${method}: connection did not open within ${options.timeoutMs}ms`);
            if (closed)
                throw new Error('CDP endpoint is closed');
            const id = nextId++;
            const outcome = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`CDP ${method} timed out after ${options.timeoutMs}ms`));
                }, options.timeoutMs);
                pending.set(id, { resolve, reject, timer });
            });
            socket.send(JSON.stringify({ id, method, params }));
            return outcome;
        },
        onEvent(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        close() {
            if (closed)
                return;
            closed = true;
            off();
            listeners.clear();
            socket.close();
            for (const [id, entry] of pending) {
                clearTimeout(entry.timer);
                entry.reject(new Error('CDP endpoint closed'));
                pending.delete(id);
            }
        },
    };
}
/**
 * Wrap a global WebSocket (Node >= 22.4 ships one) into a {@link CdpSocket}.
 * @param wsUrl - the page target's `webSocketDebuggerUrl`.
 * @param timeoutMs - connection-open bound.
 * @returns the socket; `ready` rejects on error, close, or timeout.
 */
export function websocketSocket(wsUrl, timeoutMs) {
    const ws = new WebSocket(wsUrl);
    const listeners = new Set();
    let settled = false;
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            try {
                ws.close();
            }
            catch {
                // closing an already-closed socket is a no-op
            }
            reject(new Error(`CDP websocket ${wsUrl} did not open within ${timeoutMs}ms`));
        }, timeoutMs);
        ws.addEventListener('open', () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve();
        });
        ws.addEventListener('error', () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`CDP websocket error for ${wsUrl}`));
        });
        ws.addEventListener('close', () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`CDP websocket closed before opening: ${wsUrl}`));
        });
    });
    ws.addEventListener('message', (event) => {
        const data = event.data;
        const text = typeof data === 'string' ? data : String(data);
        for (const listener of listeners)
            listener(text);
    });
    return {
        ready,
        send: (data) => ws.send(data),
        onMessage: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        close: () => ws.close(),
    };
}
//# sourceMappingURL=cdp.js.map