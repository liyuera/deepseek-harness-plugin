/**
 * Browser-side activity probe: `GET /chrome-browser/activity` behind a short
 * cache.
 *
 * The header chip polls this while a session view is open. An unreachable host
 * answers "offline" rather than throwing into React: a chip that flickers an
 * error is worse than one that says the bridge is not there, which is also the
 * truth.
 * @module @liyuera/dsh-chrome-browser/client/activity
 */
/** Which of the states the chip can show. */
export type ActivityPhase = 'offline' | 'stale' | 'running' | 'done' | 'error' | 'ready';
/** One snapshot as the host route answers it. */
export interface ActivityInfo {
    /** State to render. */
    phase: ActivityPhase;
    /** Tool the phase belongs to, when it belongs to a call. */
    tool?: string;
    /** Tab that call named, when it named one. */
    tabId?: string;
    /** Failure text, shortened, when the phase is `error`. */
    detail?: string;
    /** Epoch milliseconds this phase began. */
    since?: number;
}
/**
 * Read the plugin's current activity for one session.
 * @param sessionId - the session the chip belongs to.
 * @returns the snapshot, or an offline one while the host is unreachable.
 */
export declare function readChromeActivity(sessionId: string): Promise<ActivityInfo>;
/** Drop the cache; exposed so a test can start from a clean probe. */
export declare function resetChromeActivityCache(): void;
//# sourceMappingURL=activity.d.ts.map