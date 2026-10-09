/**
 * chrome-browser plugin, node half. Registers eight model tools that drive a
 * browser through the extension bridge (default) or the Chrome DevTools
 * Protocol (cdp fallback): list tabs, read page content, navigate, open
 * tabs, capture screenshots, click, type, and evaluate JS — plus the
 * same-origin routes the browser half uses to list tabs, bind them per
 * session, and serve the extension bridge WebSocket, and the pre-step hook
 * that expands a tab citation into a context message.
 * @module @liuyera/dsh-chrome-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { buildBackend } from './backend.ts'
import { SessionBindings } from './bindings.ts'
import { resolveChromeConfig } from './chrome.ts'
import type { ChromeMode, ResolvedChromeConfig } from './chrome.ts'
import { expandTabMentions } from './mentions.ts'
import { registerChromeRoutes } from './routes.ts'
import { chromeToolDefinitions } from './tools.ts'

/** Plugin identity. */
export const name = 'chrome-browser'

/**
 * Services required by the host half. `webServer` is a hard dependency for
 * apply ordering: `tools` is provided early, `webServer` late in the boot
 * sequence — a plugin that only guards on `ctx.get('webServer')` would apply
 * before the HTTP carrier exists and its routes would silently never
 * register (the dev-dock plugin survives this only because its own injects,
 * settings/workspaceRegistry, resolve later than webServer).
 */
export const inject = ['tools', 'webServer']

/** Plugin configuration (all fields optional; schema supplies defaults). */
export interface ChromePluginConfig {
  /** Browser backend: `extension` (default, the user's real Chrome via the extension bridge) or `cdp`. */
  backend?: 'extension' | 'cdp'
  /** DevTools HTTP port (9222; cdp backends only). */
  port?: number
  /** Explicit Chrome executable path; automatic detection when omitted. */
  chromePath?: string
  /** Chrome `--user-data-dir` (cdp backends only). */
  profileDir?: string
  /** `user` = the user's own copy profile; `owned` = dedicated instance (cdp backends only). */
  mode?: ChromeMode
  /** `user` mode: relaunch Chrome with the debug port when it runs without one. */
  autoRelaunch?: boolean
  /** Connect to an existing DevTools endpoint only; the plugin never spawns or kills Chrome. */
  attachOnly?: boolean
  /** chrome_read visible-text budget, code points (30000). */
  readTextLimit?: number
  /** chrome_navigate load-wait bound in milliseconds (8000; 0 = no wait). */
  waitLoadMs?: number
  /** Per-command and readiness bound in milliseconds (15000). */
  timeoutMs?: number
  /** Screenshot output directory; defaults to <tmp>/dsh-chrome-shots. */
  screenshotDir?: string
}

/** Runtime configuration schema for the plugin. */
export const Config: z<ChromePluginConfig> = z.object({
  backend: z.union([z.const('extension'), z.const('cdp')]).default('extension'),
  port: z.number().step(1).min(1).max(65535).default(9222),
  chromePath: z.string(),
  profileDir: z.string(),
  mode: z.union([z.const('user'), z.const('owned')]).default('owned'),
  autoRelaunch: z.boolean().default(false),
  attachOnly: z.boolean().default(false),
  readTextLimit: z.number().step(1).min(100).default(30000),
  waitLoadMs: z.number().step(1).min(0).default(8000),
  timeoutMs: z.number().step(1).min(100).default(15000),
  screenshotDir: z.string(),
})

/**
 * Register the chrome-browser plugin: eight model tools, the browser-half
 * routes (including the extension bridge upgrade), the citation expansion, and
 * one effect that disposes the backend when the plugin unmounts.
 * @param ctx - Cordis context with the tool registry and HTTP carrier.
 * @param config - the plugin configuration (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config: ChromePluginConfig = {}): void {
  const resolved: ResolvedChromeConfig = resolveChromeConfig(config)
  const { backend, chrome } = buildBackend(resolved)
  if (chrome !== undefined) chrome.reclaimOwnedLeftover()
  const bindings = new SessionBindings()
  for (const definition of chromeToolDefinitions(backend, resolved, bindings)) {
    ctx.tools.register(definition)
  }
  registerChromeRoutes(ctx, backend, bindings, config.screenshotDir ?? resolveChromeConfig(config).screenshotDir)

  // A message citing tabs gains one context message carrying their URLs and
  // ids. Only the messages this step admits are scanned, and the context
  // message's own source keeps it out of the next scan.
  ctx.on('agent/pre-step', async (_payload, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const messages = await expandTabMentions(decision.messages, () => backend.listTabs())
    return messages === undefined ? decision : { ...decision, messages }
  }, { prepend: true })

  ctx.effect(() => () => backend.dispose(), 'chrome-browser: backend lifecycle')
}
