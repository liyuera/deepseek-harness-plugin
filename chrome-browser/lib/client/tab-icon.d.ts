/**
 * Favicon renderer for the `@` tab rows.
 *
 * The candidate icon seat takes a component, not an image URL, so each
 * favicon needs one. Components are memoized by URL: a fresh component
 * identity per candidate would remount every row's image on each menu render
 * (every keystroke) and reload it.
 * @module @liuyera/dsh-chrome-browser/client/tab-icon
 */
import type { ComponentType } from 'react';
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives';
/**
 * Icon component for one favicon.
 * @param favicon - favicon URL, or '' when Chrome reported none.
 * @returns the component handed to `InputTriggerCandidate.icon`.
 */
export declare function tabIcon(favicon: string): ComponentType<IconProps>;
//# sourceMappingURL=tab-icon.d.ts.map