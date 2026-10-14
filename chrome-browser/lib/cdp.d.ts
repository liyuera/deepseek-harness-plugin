/**
 * Minimal Chrome DevTools Protocol (CDP) client. Command framing, id
 * matching, timeouts, and teardown live here; the transport behind a
 * {@link CdpSocket} is injectable so framing logic is unit-testable without a
 * real WebSocket.
 * @module @liyuera/dsh-chrome-browser/cdp
 */
/** One opened CDP socket: a connection that delivers text frames. */
export interface CdpSocket {
    /** Resolves when the connection is open; rejects when it fails or closes first. */
    readonly ready: Promise<void>;
    /** Send one text frame. */
    send(data: string): void;
    /** Subscribe to text frames; returns the disposer. */
    onMessage(listener: (data: string) => void): () => void;
    /** Close the connection. Idempotent. */
    close(): void;
}
/** One CDP session against a page target. */
export interface CdpEndpoint {
    /** Send one CDP command and await its `result`; rejects on CDP error or timeout. */
    call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
    /**
     * Subscribe to CDP events: frames carrying a `method` and no numeric id.
     * @param listener - receives the event name and its params.
     * @returns the disposer.
     */
    onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void;
    /** Close the session; in-flight calls reject and listeners stop with a closed-endpoint error. */
    close(): void;
}
export interface CdpEndpointOptions {
    /** Per-command timeout in milliseconds. */
    timeoutMs: number;
}
/** Race `promise` against a deadline; the loser's timer is always cleared. */
export declare function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T>;
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
export declare function cdpEndpoint(socket: CdpSocket, options: CdpEndpointOptions): CdpEndpoint;
/**
 * Wrap a global WebSocket (Node >= 22.4 ships one) into a {@link CdpSocket}.
 * @param wsUrl - the page target's `webSocketDebuggerUrl`.
 * @param timeoutMs - connection-open bound.
 * @returns the socket; `ready` rejects on error, close, or timeout.
 */
export declare function websocketSocket(wsUrl: string, timeoutMs: number): CdpSocket;
//# sourceMappingURL=cdp.d.ts.map