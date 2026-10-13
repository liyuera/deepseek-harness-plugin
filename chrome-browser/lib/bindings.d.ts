/**
 * Per-session selected-tab bindings: which browser tabs a conversation is
 * working on, in selection order (the first is the tool default). In-memory
 * only, bounded by an LRU cap — the binding is a transient working hint,
 * never durable state.
 * @module @liyuera/dsh-chrome-browser/bindings
 */
/** Session-id → tab-id list bindings with an LRU cap. */
export declare class SessionBindings {
    private readonly capacity;
    private readonly entries;
    private seq;
    constructor(capacity?: number);
    /** The session's default tab (first selected), when one exists. */
    get(sessionId: string): string | undefined;
    /** Every selected tab for one session, in selection order. */
    all(sessionId: string): string[];
    /** Bind (or replace) the full selection for one session. */
    set(sessionId: string, tabIds: readonly string[]): void;
    /** Number of live bindings (observability for tests). */
    get size(): number;
}
//# sourceMappingURL=bindings.d.ts.map