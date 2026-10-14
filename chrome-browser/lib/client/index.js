/**
 * chrome-browser plugin, browser half.
 *
 * The composer dock used to carry a full-width tab selector above the input
 * card. That row, its component and the session-binding routes behind it are
 * gone: the live tab list lives in the `@` menu, where a pick inserts a
 * reference chip and binds nothing. The dock carries the activity strip now.
 * @module @liyuera/dsh-chrome-browser/client
 */
import { BrowserActivity } from "./BrowserActivity.js";
import { listChromeTabs } from "./tab-catalog.js";
import { createChromeTabSource } from "./tab-source.js";
import { tabIcon } from "./tab-icon.js";
/** Required services for the slot contribution and the `@` source. */
export const inject = ['slots', 'inputTriggers'];
/**
 * Client plugin body: register the activity strip and the `@` tab source.
 * @param ctx - client root context.
 */
export function apply(ctx) {
    // The activity strip: rendered above the composer only while one of this
    // plugin's tools is running, so a user who looks up mid-task can see that the
    // agent is driving their browser and on which tab.
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'chrome-browser-activity',
        order: 4,
    }, BrowserActivity));
    ctx.effect(() => ctx.inputTriggers.registerSource(createChromeTabSource({ listTabs: listChromeTabs, iconFor: tabIcon })), 'chrome-browser: @ tab source');
}
//# sourceMappingURL=index.js.map