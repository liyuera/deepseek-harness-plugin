/**
 * Bounded console capture, one buffer per tab.
 *
 * The bounds are count and bytes, never time: a page that logs in a loop can
 * produce more text in one second than a quiet page produces in an hour, so a
 * retention window cannot bound memory. What bounds it is a fixed number of
 * entries and a fixed text budget per tab, plus a fixed number of captured tabs
 * — together a constant ceiling that does not grow with how long the plugin
 * runs.
 *
 * Nothing here is durable. Entries live in the host process for as long as the
 * tab is captured and are never written to the session log; only what a caller
 * reads back enters a transcript.
 * @module @liyuera/dsh-chrome-browser/console-log
 */

/** Entries one tab keeps; the oldest are dropped past this. */
export const MAX_ENTRIES = 200

/**
 * Text one tab keeps across all its entries, in UTF-16 code units. V8 stores an
 * all-Latin-1 string one byte per unit and a wider string two, so a tab holds
 * 256 KB of ASCII or 512 KB of CJK — the ceiling is this constant times
 * {@link MAX_TABS}, and it does not depend on how long the plugin runs.
 */
export const MAX_CHARS = 256 * 1024

/** Text one entry keeps; a longer message keeps its head plus a marker. */
export const MAX_ENTRY_CHARS = 4096

/** Tabs captured at once; tracking one more releases the least recently used. */
export const MAX_TABS = 5

/** Marker appended to a message the per-entry cap cut short. */
const TRUNCATED = '…[truncated]'

/** One captured console message. */
export interface ConsoleEntry {
  /** Monotonic per tab; `since` cursors compare against it. */
  readonly seq: number
  /** Epoch milliseconds when the host recorded it. */
  readonly at: number
  /** Level the page reported (`log`, `warning`, `error`, …). */
  readonly level: string
  /** Message text, already capped to {@link MAX_ENTRY_CHARS}. */
  readonly text: string
  /** Call site the browser reported, when it reported one. */
  readonly source?: string
}

/** One tab's retained window, plus what fell out of it. */
export interface ConsolePage {
  /** Entries after the cursor, oldest first. */
  readonly entries: readonly ConsoleEntry[]
  /** Entries currently retained for the tab. */
  readonly retained: number
  /** Entries evicted since capture started on this tab. */
  readonly dropped: number
  /** Cursor to pass as `since` next time; equals the newest returned `seq`. */
  readonly cursor: number
}

/** One tab's buffer state. */
interface Buffer {
  entries: ConsoleEntry[]
  /** Sum of `entries[].text.length`, maintained incrementally. */
  chars: number
  /** Newest sequence handed out. */
  seq: number
  /** Entries evicted since capture started. */
  dropped: number
  /** Recency stamp for {@link ConsoleLog.track} eviction. */
  used: number
}

/** Cap one message, keeping its head so an oversized line cannot clear the buffer. */
export function capMessage(text: string): string {
  return text.length <= MAX_ENTRY_CHARS ? text : `${text.slice(0, MAX_ENTRY_CHARS)}${TRUNCATED}`
}

/**
 * A per-tab console window with fixed memory bounds. Every operation is O(1)
 * amortized: eviction pops from the front, and the retained character count is
 * maintained on append rather than recomputed.
 */
export class ConsoleLog {
  private readonly buffers = new Map<string, Buffer>()
  private clock = 0

  /** Whether one tab is currently captured. */
  tracks(tabId: string): boolean {
    return this.buffers.has(tabId)
  }

  /** Captured tab ids, most recently used first. */
  tracked(): string[] {
    return [...this.buffers.entries()]
      .sort((left, right) => right[1].used - left[1].used)
      .map(([tabId]) => tabId)
  }

  /**
   * Begin capturing one tab. Idempotent: a tab already captured keeps its
   * window, which matters when a reconnecting bridge re-arms capture. Tracking
   * past {@link MAX_TABS} releases the least recently used tab.
   * @param tabId - the tab to capture.
   * @returns the tab id released to stay within the cap, when one was.
   */
  track(tabId: string): string | undefined {
    const existing = this.buffers.get(tabId)
    if (existing !== undefined) {
      existing.used = ++this.clock
      return undefined
    }
    let released: string | undefined
    if (this.buffers.size >= MAX_TABS) {
      const oldest = this.tracked().at(-1)
      if (oldest !== undefined) {
        this.buffers.delete(oldest)
        released = oldest
      }
    }
    this.buffers.set(tabId, { entries: [], chars: 0, seq: 0, dropped: 0, used: ++this.clock })
    return released
  }

  /** Stop capturing one tab and drop everything it held. */
  release(tabId: string): void {
    this.buffers.delete(tabId)
  }

  /** Stop capturing every tab. */
  releaseAll(): void {
    this.buffers.clear()
  }

  /**
   * Record one message on a captured tab. A tab that is not captured is
   * ignored, so a late event from a released tab cannot resurrect its buffer.
   * @param tabId - the tab the message came from.
   * @param entry - level, text and optional call site.
   * @returns whether the entry was retained.
   */
  append(tabId: string, entry: Omit<ConsoleEntry, 'seq' | 'at'> & { at?: number }): boolean {
    const buffer = this.buffers.get(tabId)
    if (buffer === undefined) return false
    const text = capMessage(entry.text)
    buffer.entries.push({
      seq: ++buffer.seq,
      at: entry.at ?? Date.now(),
      level: entry.level,
      text,
      ...(entry.source === undefined ? {} : { source: entry.source }),
    })
    buffer.chars += text.length
    buffer.used = ++this.clock
    this.evict(buffer)
    return true
  }

  /**
   * Read the window a caller has not seen yet.
   * @param tabId - the captured tab.
   * @param options - `since` is an exclusive cursor (0 starts at the beginning);
   *   `limit` keeps the most recent entries of the matching set.
   * @returns the page, or undefined when the tab is not captured.
   */
  read(tabId: string, options: { since?: number; limit?: number } = {}): ConsolePage | undefined {
    const buffer = this.buffers.get(tabId)
    if (buffer === undefined) return undefined
    const since = options.since ?? 0
    const matching = buffer.entries.filter(entry => entry.seq > since)
    const limit = options.limit ?? MAX_ENTRIES
    const entries = limit >= matching.length ? matching : matching.slice(-limit)
    return {
      entries,
      retained: buffer.entries.length,
      dropped: buffer.dropped,
      cursor: entries.at(-1)?.seq ?? since,
    }
  }

  /** Drop one tab's entries but keep capturing it; the cursor continues from the newest seq. */
  clear(tabId: string): boolean {
    const buffer = this.buffers.get(tabId)
    if (buffer === undefined) return false
    buffer.entries = []
    buffer.chars = 0
    return true
  }

  /** Retained text across every captured tab, in code units (observability for tests). */
  get retainedChars(): number {
    let total = 0
    for (const buffer of this.buffers.values()) total += buffer.chars
    return total
  }

  /** Drop the oldest entries until both the count and the text budget hold. */
  private evict(buffer: Buffer): void {
    while (buffer.entries.length > MAX_ENTRIES || buffer.chars > MAX_CHARS) {
      const dropped = buffer.entries.shift()
      if (dropped === undefined) return
      buffer.chars -= dropped.text.length
      buffer.dropped += 1
    }
  }
}
