/**
 * chrome-browser plugin, browser half.
 *
 * The composer dock used to carry a full-width tab selector above the input
 * card; that row is retired and the live tab list now lives in the `@` menu,
 * where a pick inserts a reference chip naming the tab. The dock registration
 * and its component stay in the tree, switched off by {@link TAB_PICKER_VISIBLE}.
 * @module @liuyera/dsh-chrome-browser/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { TabPicker } from './TabPicker.tsx'
import { listChromeTabs } from './tab-catalog.ts'
import { createChromeTabSource } from './tab-source.ts'
import { tabIcon } from './tab-icon.ts'

export type { TabPickerProps } from './TabPicker.tsx'

/**
 * Whether the composer-dock tab selector registers. The `@` tab source
 * replaced it, so the row stays hidden by default; flip this to true to bring
 * the dock row back.
 */
const TAB_PICKER_VISIBLE = false

/** Required services for the slot contribution and the `@` source. */
export const inject = ['slots', 'inputTriggers']

/**
 * Client plugin body: register the `@` tab source, and the retired dock
 * selector only while it is switched on.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  if (TAB_PICKER_VISIBLE) {
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'chrome-browser-tab-select',
      order: 5,
    }, TabPicker))
  }

  ctx.effect(
    () => ctx.inputTriggers.registerSource(createChromeTabSource({ listTabs: listChromeTabs, iconFor: tabIcon })),
    'chrome-browser: @ tab source',
  )
}
