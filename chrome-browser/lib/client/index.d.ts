/**
 * chrome-browser plugin, browser half.
 *
 * The composer dock used to carry a full-width tab selector above the input
 * card. That row, its component and the session-binding routes behind it are
 * gone: the live tab list lives in the `@` menu, where a pick inserts a
 * reference chip and binds nothing. The dock carries the activity strip now.
 * @module @liyuera/dsh-chrome-browser/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** Required services for the slot contribution and the `@` source. */
export declare const inject: string[];
/**
 * Client plugin body: register the activity strip and the `@` tab source.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map