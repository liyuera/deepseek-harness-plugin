/**
 * Chrome status chip: the one place the user can see, without reading the
 * transcript, whether the plugin can drive their browser and what it is doing
 * with it right now.
 *
 * It sits at the end of the Session header's utilities and is **always**
 * rendered — a pale idle state that is legible at a glance, and a louder one
 * only for the phases that ask for attention (a call in flight, a failure, an
 * extension that needs reloading). An indicator that appears only while a call
 * runs is not readable: those calls finish in milliseconds, so it reads as a
 * flicker rather than as information.
 * @module @liyuera/dsh-chrome-browser/client/activity-strip
 */
import React from 'react';
/** Props every Session-header utility receives. */
export interface BrowserActivityProps {
    sessionId: string;
}
/**
 * Render the persistent Chrome status chip.
 * @param props - the header utility's session identity.
 * @returns the chip.
 */
export declare function BrowserActivity({ sessionId }: BrowserActivityProps): React.ReactElement;
//# sourceMappingURL=BrowserActivity.d.ts.map