/**
 * `@` trigger source listing the user's live Chrome tabs.
 *
 * A row shows the tab title with its URL right after it: the title is the
 * candidate label, the URL rides the menu's right-aligned description seat.
 * A pick inserts a reference chip and binds nothing: the chip carries the
 * mention token the transcript projects as a reference, and the host expands
 * that mention into a context message naming the tab's URL and id, so the
 * user's message stays a reference while the model still gets the exact tab.
 * One pick covers the one message it lands in; the next message starts from a
 * clean draft.
 *
 * The menu's own group title is owned by ui-input-trigger's dictionary, so
 * this source declares no group title and carries a section heading on every
 * row instead (the saved-prompt source does the same).
 * @module @liuyera/dsh-chrome-browser/client/tab-source
 */
import type { ComponentType } from 'react';
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives';
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client';
import type { TabInfo } from './TabPicker.tsx';
/** Source name: the `@` roster key and the reference owner a chip routes back through. */
export declare const CHROME_TAB_SOURCE_NAME = "chrome-browser";
/**
 * Menu position among `@` sources. Lower sorts higher, the saved-prompt source
 * declares -100, and the file/session source declares none (0) — so -200 is
 * what puts live tabs above every other `@` group.
 */
export declare const CHROME_TAB_SOURCE_ORDER = -200;
/** Rows rendered for one query, at most. */
export declare const CANDIDATE_LIMIT = 50;
/** Section heading every row carries, in place of a group title. */
export declare const TAB_SECTION = "\u6D4F\u89C8\u5668\u6807\u7B7E\u9875";
/** What the source needs from its host: the live tab list and one favicon renderer. */
export interface ChromeTabSourceDeps {
    /**
     * List the live Chrome tabs.
     * @param signal - superseded when the query changes or the menu closes.
     * @returns the tabs, an empty list while the browser is unreachable.
     */
    listTabs(signal: AbortSignal): Promise<readonly TabInfo[]>;
    /**
     * Icon component for one favicon.
     * @param favicon - favicon URL, or '' when Chrome reported none.
     * @returns the component handed to the candidate icon seat.
     */
    iconFor(favicon: string): ComponentType<IconProps>;
}
/**
 * Build the `@` source over the live tab list.
 * @param deps - tab listing and favicon rendering, injected for tests.
 * @returns the source registered on `ctx.inputTriggers`.
 */
export declare function createChromeTabSource(deps: ChromeTabSourceDeps): InputTriggerSource;
//# sourceMappingURL=tab-source.d.ts.map