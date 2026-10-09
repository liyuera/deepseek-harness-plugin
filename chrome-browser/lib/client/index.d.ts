/**
 * chrome-browser plugin, browser half.
 *
 * The composer dock used to carry a full-width tab selector above the input
 * card; that row is retired and the live tab list now lives in the `@` menu,
 * where a pick inserts a reference chip naming the tab. The dock registration
 * and its component stay in the tree, switched off by {@link TAB_PICKER_VISIBLE}.
 * @module @liuyera/dsh-chrome-browser/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
export type { TabPickerProps } from './TabPicker.tsx';
/** Required services for the slot contribution and the `@` source. */
export declare const inject: string[];
/**
 * Client plugin body: register the `@` tab source, and the retired dock
 * selector only while it is switched on.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map