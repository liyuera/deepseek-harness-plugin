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
export declare const MAX_ENTRIES = 200;
/**
 * Text one tab keeps across all its entries, in UTF-16 code units. V8 stores an
 * all-Latin-1 string one byte per unit and a wider string two, so a tab holds
 * 256 KB of ASCII or 512 KB of CJK — the ceiling is this constant times
 * {@link MAX_TABS}, and it does not depend on how long the plugin runs.
 */
export declare const MAX_CHARS: number;
/** Text one entry keeps; a longer message keeps its head plus a marker. */
export declare const MAX_ENTRY_CHARS = 4096;
/** Tabs captured at once; tracking one more releases the least recently used. */
export declare const MAX_TABS = 5;
/** One captured console message. */
export interface ConsoleEntry {
    /** Monotonic per tab; `since` cursors compare against it. */
    readonly seq: number;
    /** Epoch milliseconds when the host recorded it. */
    readonly at: number;
    /** Level the page reported (`log`, `warning`, `error`, …). */
    readonly level: string;
    /** Message text, already capped to {@link MAX_ENTRY_CHARS}. */
    readonly text: string;
    /** Call site the browser reported, when it reported one. */
    readonly source?: string;
}
/** One tab's retained window, plus what fell out of it. */
export interface ConsolePage {
    /** Entries after the cursor, oldest first. */
    readonly entries: readonly ConsoleEntry[];
    /** Entries currently retained for the tab. */
    readonly retained: number;
    /** Entries evicted since capture started on this tab. */
    readonly dropped: number;
    /** Cursor to pass as `since` next time; equals the newest returned `seq`. */
    readonly cursor: number;
}
/** Cap one message, keeping its head so an oversized line cannot clear the buffer. */
export declare function capMessage(text: string): string;
/**
 * A per-tab console window with fixed memory bounds. Every operation is O(1)
 * amortized: eviction pops from the front, and the retained character count is
 * maintained on append rather than recomputed.
 */
export declare class ConsoleLog {
    private readonly buffers;
    private clock;
    /** Whether one tab is currently captured. */
    tracks(tabId: string): boolean;
    /** Captured tab ids, most recently used first. */
    tracked(): string[];
    /**
     * Begin capturing one tab. Idempotent: a tab already captured keeps its
     * window, which matters when a reconnecting bridge re-arms capture. Tracking
     * past {@link MAX_TABS} releases the least recently used tab.
     * @param tabId - the tab to capture.
     * @returns the tab id released to stay within the cap, when one was.
     */
    track(tabId: string): string | undefined;
    /** Stop capturing one tab and drop everything it held. */
    release(tabId: string): void;
    /** Stop capturing every tab. */
    releaseAll(): void;
    /**
     * Record one message on a captured tab. A tab that is not captured is
     * ignored, so a late event from a released tab cannot resurrect its buffer.
     * @param tabId - the tab the message came from.
     * @param entry - level, text and optional call site.
     * @returns whether the entry was retained.
     */
    append(tabId: string, entry: Omit<ConsoleEntry, 'seq' | 'at'> & {
        at?: number;
    }): boolean;
    /**
     * Read the window a caller has not seen yet.
     * @param tabId - the captured tab.
     * @param options - `since` is an exclusive cursor (0 starts at the beginning);
     *   `limit` keeps the most recent entries of the matching set.
     * @returns the page, or undefined when the tab is not captured.
     */
    read(tabId: string, options?: {
        since?: number;
        limit?: number;
    }): ConsolePage | undefined;
    /** Drop one tab's entries but keep capturing it; the cursor continues from the newest seq. */
    clear(tabId: string): boolean;
    /** Retained text across every captured tab, in code units (observability for tests). */
    get retainedChars(): number;
    /** Drop the oldest entries until both the count and the text budget hold. */
    private evict;
}
//# sourceMappingURL=console-log.d.ts.map