/**
 * Browser-side activity probe: `GET /chrome-browser/activity` behind a short
 * cache.
 *
 * The strip polls this while a session view is open, so a dropped request or an
 * unreachable host answers "not active" rather than throwing into React: an
 * indicator that flickers an error is worse than one that stays hidden.
 * @module @liyuera/dsh-chrome-browser/client/activity
 */
/** One snapshot as the host route answers it. */
export interface ActivityInfo {
    active: boolean;
    tool?: string;
    tabId?: string;
    startedAt?: number;
    lastTool?: string;
    lastAt?: number;
}
/**
 * Read the plugin's current activity for one session.
 * @param sessionId - the session the strip belongs to.
 * @returns the snapshot, or an inactive one while the host is unreachable.
 */
export declare function readChromeActivity(sessionId: string): Promise<ActivityInfo>;
/** Drop the cache; exposed so a test can start from a clean probe. */
export declare function resetChromeActivityCache(): void;
//# sourceMappingURL=activity.d.ts.map