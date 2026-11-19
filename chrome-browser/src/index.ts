/**
 * chrome-browser plugin, node half. Registers eight model tools that drive a
 * browser through the extension bridge (default) or the Chrome DevTools
 * Protocol (cdp fallback): list tabs, read page content, navigate, open
 * tabs, capture screenshots, click, type, and evaluate JS — plus the
 * same-origin routes the browser half uses to list tabs, bind them per
 * session, and serve the extension bridge WebSocket, the pre-step hook that
 * expands a tab citation into a context message, the `chrome-browser` agent
 * skill (when this composition exposes a skill registry), and the human-help
 * channel behind `chrome_request_help` (when it exposes a question service).
 * @module @liyuera/dsh-chrome-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { ActivityTracker, withActivity } from './activity.ts'
import { buildBackend, CdpBackend } from './backend.ts'
import { BackendRegistry } from './backend-registry.ts'
import type { SandboxFactory } from './backend-registry.ts'
import { Chrome, DEFAULT_BRIDGE_PORT, DEFAULT_CONSOLE_IDLE_MS, resolveChromeConfig } from './chrome.ts'
import type { ChromeMode, ResolvedChromeConfig } from './chrome.ts'
import { ConsoleLog } from './console-log.ts'
import { installExtensionBridge } from './bridge.ts'
import { HelpChannel, registerHelpChannel } from './help.ts'
import { expandTabMentions } from './mentions.ts'
import { registerChromeRoutes } from './routes.ts'
import { registerChromeSkill } from './skill.ts'
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
  /** Browser backend: `extension` (default, the user's real Chrome via the extension bridge), `cdp`, or `sandbox`. */
  backend?: 'extension' | 'cdp' | 'sandbox'
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
  /**
   * chrome_console idle bound in milliseconds (300000; 0 disables). A capture
   * with no read for this long releases Chrome's debugger automatically; the
   * entries already collected stay readable.
   */
  consoleIdleMs?: number
  /**
   * Loopback port of this plugin's own extension bridge (21987). The shipped
   * extension dials it and cannot discover another; `0` asks the OS for a free
   * port (tests and diagnostics only).
   */
  bridgePort?: number
  /** Max concurrent sandbox instances (backend:'sandbox' only). */
  sandboxMaxConcurrent?: number
  /** Idle reclamation bound in ms for a sandbox; 0 = never. */
  sandboxIdleMs?: number
  /** Run sandbox Chrome headless (default true = no window). */
  sandboxHeadless?: boolean
}

/** Runtime configuration schema for the plugin. */
export const Config: z<ChromePluginConfig> = z.object({
  backend: z.union([z.const('extension'), z.const('cdp'), z.const('sandbox')]).default('extension'),
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
  consoleIdleMs: z.number().step(1).min(0).default(DEFAULT_CONSOLE_IDLE_MS),
  bridgePort: z.number().step(1).min(0).max(65535).default(DEFAULT_BRIDGE_PORT),
  sandboxMaxConcurrent: z.number().step(1).min(1).default(4),
  sandboxIdleMs: z.number().step(1).min(0).default(10 * 60_000),
  sandboxHeadless: z.boolean().default(true),
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
  // The console buffer lives here, in the long-lived host: the extension's
  // service worker is suspended by Chrome and would lose it silently.
  const consoleLog = new ConsoleLog()
  const { backend: shared, chrome } = buildBackend(resolved, (tabId, message) => {
    consoleLog.append(tabId, message)
  })
  if (chrome !== undefined) chrome.reclaimOwnedLeftover()

  // 沙箱工厂：每个 agent 一个 owned CDP 实例，console 汇入共享缓冲。
  const factory: SandboxFactory = (cfg) => {
    const instance = new Chrome(cfg)
    return new CdpBackend(instance, (tabId, message) => consoleLog.append(tabId, message))
  }
  const registry = new BackendRegistry(resolved, shared, factory)

  const help = new HelpChannel()
  const activity = new ActivityTracker()
  for (const definition of chromeToolDefinitions((exec, pref) => registry.resolve(exec, pref), resolved, consoleLog, help)) {
    ctx.tools.register(withActivity(definition, activity))
  }
  registerHelpChannel(ctx, help)
  // 扩展桥与路由仍针对「用户真实浏览器」（shared），不是 per-agent 沙箱。
  // sandbox 模式下也安装：工具默认走沙箱，但 `backend: 'user'` 需要 shared 可
  // 达（以及 `@` 菜单/标签页路由读的是真实 Chrome）。cdp 后端没有扩展后端，
  // 因此不安装。
  const bridge = resolved.backend !== 'cdp'
    ? installExtensionBridge(ctx, shared, resolved.screenshotDir, resolved.bridgePort)
    : undefined
  registerChromeRoutes(ctx, shared, resolved.screenshotDir, activity, bridge)
  registerChromeSkill(ctx)

  // 会话/子代理结束 → 释放其沙箱。
  ctx.on('agent/disposed', (payload) => {
    const id = (payload as { agent?: { id?: unknown } }).agent?.id
    if (typeof id === 'string' && id !== '') registry.release(id)
  })

  ctx.on('agent/pre-step', async (_payload, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const messages = await expandTabMentions(decision.messages, () => shared.listTabs())
    return messages === undefined ? decision : { ...decision, messages }
  }, { prepend: true })

  ctx.effect(() => () => {
    consoleLog.releaseAll()
    activity.clear()
    registry.dispose()
  }, 'chrome-browser: backend lifecycle')
}
