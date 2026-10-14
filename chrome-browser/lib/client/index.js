/**
 * chrome-browser plugin, browser half.
 *
 * The composer dock used to carry a full-width tab selector above the input
 * card. That row, its component and the session-binding routes behind it are
 * gone: the live tab list lives in the `@` menu, where a pick inserts a
 * reference chip and binds nothing. The Session header carries the status chip.
 * @module @liyuera/dsh-chrome-browser/client
 */
import { BrowserActivity } from "./BrowserActivity.js";
import { listChromeTabs } from "./tab-catalog.js";
import { createChromeTabSource } from "./tab-source.js";
import { tabIcon } from "./tab-icon.js";
/** Required services for the slot contribution and the `@` source. */
export const inject = ['slots', 'inputTriggers'];
/**
 * Client plugin body: register the Chrome status chip and the `@` tab source.
 * @param ctx - client root context.
 */
export function apply(ctx) {
    // The status chip: the last item in the Session header's trailing utilities,
    // so the state of the browser bridge sits with the other session-level
    // facts. It stays mounted and stays visible — a chip that only appears while
    // a call runs flickers past, because these calls finish in milliseconds.
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'chrome-browser-activity',
        order: 90,
    }, BrowserActivity));
    ctx.effect(() => ctx.inputTriggers.registerSource(createChromeTabSource({ listTabs: listChromeTabs, iconFor: tabIcon })), 'chrome-browser: @ tab source');
}
//# sourceMappingURL=index.js.map