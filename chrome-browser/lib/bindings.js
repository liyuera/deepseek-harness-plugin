/**
 * Per-session selected-tab bindings: which browser tabs a conversation is
 * working on, in selection order (the first is the tool default). In-memory
 * only, bounded by an LRU cap — the binding is a transient working hint,
 * never durable state.
 * @module @liyuera/dsh-chrome-browser/bindings
 */
/** Session-id → tab-id list bindings with an LRU cap. */
export class SessionBindings {
    capacity;
    entries = new Map();
    seq = 0;
    constructor(capacity = 500) {
        this.capacity = capacity;
    }
    /** The session's default tab (first selected), when one exists. */
    get(sessionId) {
        return this.all(sessionId)[0];
    }
    /** Every selected tab for one session, in selection order. */
    all(sessionId) {
        const entry = this.entries.get(sessionId);
        if (entry === undefined)
            return [];
        entry.seq = ++this.seq;
        return [...entry.tabIds];
    }
    /** Bind (or replace) the full selection for one session. */
    set(sessionId, tabIds) {
        this.entries.set(sessionId, { tabIds: [...tabIds], seq: ++this.seq });
        if (this.entries.size <= this.capacity)
            return;
        let oldest;
        let oldestSeq = Number.POSITIVE_INFINITY;
        for (const [id, entry] of this.entries) {
            if (entry.seq < oldestSeq) {
                oldest = id;
                oldestSeq = entry.seq;
            }
        }
        if (oldest !== undefined)
            this.entries.delete(oldest);
    }
    /** Number of live bindings (observability for tests). */
    get size() {
        return this.entries.size;
    }
}
//# sourceMappingURL=bindings.js.map