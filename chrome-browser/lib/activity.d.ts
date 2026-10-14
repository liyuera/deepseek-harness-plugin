/**
 * What the plugin is doing right now, for the persistent header indicator.
 *
 * The host half is the only place that knows a call is in flight, so it records
 * every tool execution here and serves the snapshot over its own route; the
 * browser half polls that route and renders one chip in the Session header.
 * Nothing is persisted, and nothing crosses into the model's request.
 * @module @liyuera/dsh-chrome-browser/activity
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
/**
 * How long a settled call stays on screen before the chip returns to idle.
 * Short enough not to linger, long enough that a call finishing between two
 * polls is still seen: the browser half polls at POLL_MS, so a hold shorter
 * than one poll interval can be missed entirely.
 */
export declare const DONE_HOLD_MS = 2500;
/** How long a failure stays on screen. Longer: it asks to be read. */
export declare const ERROR_HOLD_MS = 7000;
/** Which of the four things the chip can be saying. */
export type ActivityPhase = 'running' | 'done' | 'error' | 'ready';
/** What the browser half renders from. */
export interface ActivitySnapshot {
    /** Current phase for the session being asked about. */
    readonly phase: ActivityPhase;
    /** Tool the phase belongs to, when it belongs to a call. */
    readonly tool?: string;
    /** Tab that call named, when it named one. */
    readonly tabId?: string;
    /** Failure text, shortened, when the phase is `error`. */
    readonly detail?: string;
    /** Epoch milliseconds this phase began, or the last call's start. */
    readonly since: number;
}
/** Route-facing view of one snapshot. */
export type ActivityAnswer = Record<string, string | number | boolean>;
/**
 * In-flight and recently finished browser calls, keyed by session when the
 * caller has one.
 *
 * The tracker holds facts, not timers: `snapshot` decides whether a settled
 * call is still worth showing from the clock alone. That keeps a host tick out
 * of the loop and means a browser that polls late sees the same answer a
 * host-side timer would have produced.
 */
export declare class ActivityTracker {
    private readonly running;
    private readonly settled;
    /** Session key for a caller with no session identity. */
    private static readonly ANONYMOUS;
    /**
     * Record one call as started.
     * @param tool - the tool name.
     * @param tabId - the tab the call named, when it named one.
     * @param sessionId - the calling session, when the execution carried one.
     * @returns the disposer that records how the call ended; idempotent.
     */
    begin(tool: string, tabId: string | undefined, sessionId: string | undefined): (ok: boolean, detail?: string) => void;
    /**
     * The current state for one session.
     * @param sessionId - the session to report on; omit for the most recent call in any session.
     * @returns the snapshot the chip renders from.
     */
    snapshot(sessionId?: string): ActivitySnapshot;
    /** Drop every record; the plugin calls this on unload. */
    clear(): void;
}
/**
 * Wrap one tool definition so its execution is visible to the header chip.
 *
 * Every other member is carried over untouched: this adds observation, it does
 * not change what the tool declares or returns.
 * @param definition - the registered definition.
 * @param activity - the tracker the browser half reads.
 * @returns an equivalent definition that reports the call.
 */
export declare function withActivity(definition: ToolDefinition, activity: ActivityTracker): ToolDefinition;
//# sourceMappingURL=activity.d.ts.map