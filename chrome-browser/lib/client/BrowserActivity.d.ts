/**
 * Browser activity strip: the one place the user can see, without reading the
 * transcript, that the agent is driving their browser right now.
 *
 * It renders **nothing** while the plugin is idle — a permanent badge would be
 * noise, and the per-call cards already carry the detail. When a call is in
 * flight it names the tool and the tab, so a user who looks up mid-task can
 * tell what is happening and on which page.
 * @module @liyuera/dsh-chrome-browser/client/activity-strip
 */
import React from 'react';
/** Props every composer-dock entry receives. */
export interface BrowserActivityProps {
    sessionId: string;
}
/**
 * Render the strip while one of this plugin's tools is running.
 * @param props - the dock entry's session identity.
 * @returns the strip, or null while nothing is running.
 */
export declare function BrowserActivity({ sessionId }: BrowserActivityProps): React.ReactElement | null;
//# sourceMappingURL=BrowserActivity.d.ts.map