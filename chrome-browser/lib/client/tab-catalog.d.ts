/**
 * Browser-side tab catalog: `POST /chrome-browser/tabs` behind a short cache.
 *
 * The `@` source asks for candidates on every keystroke, so the cache is what
 * keeps one typed word from becoming one host round-trip per character; a
 * failed listing is held for the same window, so an unreachable browser costs
 * one logged request instead of one per keystroke.
 * @module @liuyera/dsh-chrome-browser/client/tab-catalog
 */
import type { TabInfo } from './TabPicker.tsx';
/**
 * List the live Chrome tabs.
 * @param signal - superseded when the query changes or the menu closes; a
 *   request already in flight still settles the shared cache.
 * @returns the tabs, or an empty list while the browser is unreachable.
 */
export declare function listChromeTabs(signal: AbortSignal): Promise<readonly TabInfo[]>;
//# sourceMappingURL=tab-catalog.d.ts.map