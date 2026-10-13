/**
 * Per-session selected-tab bindings: which browser tabs a conversation is
 * working on, in selection order (the first is the tool default). In-memory
 * only, bounded by an LRU cap — the binding is a transient working hint,
 * never durable state.
 * @module @liyuera/dsh-chrome-browser/bindings
 */

interface Entry {
  tabIds: string[]
  /** Monotonic recency stamp — Date.now collides within one millisecond. */
  seq: number
}

/** Session-id → tab-id list bindings with an LRU cap. */
export class SessionBindings {
  private readonly entries = new Map<string, Entry>()
  private seq = 0

  constructor(private readonly capacity = 500) {}

  /** The session's default tab (first selected), when one exists. */
  get(sessionId: string): string | undefined {
    return this.all(sessionId)[0]
  }

  /** Every selected tab for one session, in selection order. */
  all(sessionId: string): string[] {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return []
    entry.seq = ++this.seq
    return [...entry.tabIds]
  }

  /** Bind (or replace) the full selection for one session. */
  set(sessionId: string, tabIds: readonly string[]): void {
    this.entries.set(sessionId, { tabIds: [...tabIds], seq: ++this.seq })
    if (this.entries.size <= this.capacity) return
    let oldest: string | undefined
    let oldestSeq = Number.POSITIVE_INFINITY
    for (const [id, entry] of this.entries) {
      if (entry.seq < oldestSeq) {
        oldest = id
        oldestSeq = entry.seq
      }
    }
    if (oldest !== undefined) this.entries.delete(oldest)
  }

  /** Number of live bindings (observability for tests). */
  get size(): number {
    return this.entries.size
  }
}
