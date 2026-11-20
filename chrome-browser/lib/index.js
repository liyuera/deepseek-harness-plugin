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
import z from '@deepseek-ai/schemastery';
import { ActivityTracker, withActivity } from './activity.js';
import { buildBackend, CdpBackend } from './backend.js';
import { BackendRegistry } from './backend-registry.js';
import { Chrome, DEFAULT_BRIDGE_PORT, DEFAULT_CONSOLE_IDLE_MS, resolveChromeConfig } from './chrome.js';
import { ConsoleLog } from './console-log.js';
import { installExtensionBridge } from './bridge.js';
import { HelpChannel, registerHelpChannel } from './help.js';
import { expandTabMentions } from './mentions.js';
import { registerChromeRoutes } from './routes.js';
import { registerChromeSkill } from './skill.js';
import { chromeToolDefinitions } from './tools.js';
/** Plugin identity. */
export const name = 'chrome-browser';
/**
 * Services required by the host half. `webServer` is a hard dependency for
 * apply ordering: `tools` is provided early, `webServer` late in the boot
 * sequence — a plugin that only guards on `ctx.get('webServer')` would apply
 * before the HTTP carrier exists and its routes would silently never
 * register (the dev-dock plugin survives this only because its own injects,
 * settings/workspaceRegistry, resolve later than webServer).
 */
export const inject = ['tools', 'webServer'];
/** Runtime configuration schema for the plugin. */
export const Config = z.object({
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
});
/**
 * Register the chrome-browser plugin: eight model tools, the browser-half
 * routes (including the extension bridge upgrade), the citation expansion, and
 * one effect that disposes the backend when the plugin unmounts.
 * @param ctx - Cordis context with the tool registry and HTTP carrier.
 * @param config - the plugin configuration (schema defaults applied by the loader).
 */
export function apply(ctx, config = {}) {
    const resolved = resolveChromeConfig(config);
    // The console buffer lives here, in the long-lived host: the extension's
    // service worker is suspended by Chrome and would lose it silently.
    const consoleLog = new ConsoleLog();
    const { backend: shared, chrome } = buildBackend(resolved, (tabId, message) => {
        consoleLog.append(tabId, message);
    });
    if (chrome !== undefined)
        chrome.reclaimOwnedLeftover();
    // 沙箱工厂：每个 agent 一个 owned CDP 实例，console 汇入共享缓冲。
    const factory = (cfg) => {
        const instance = new Chrome(cfg);
        return new CdpBackend(instance, (tabId, message) => consoleLog.append(tabId, message));
    };
    const registry = new BackendRegistry(resolved, shared, factory);
    const help = new HelpChannel();
    const activity = new ActivityTracker();
    for (const definition of chromeToolDefinitions((exec, pref) => registry.resolve(exec, pref), resolved, consoleLog, help)) {
        ctx.tools.register(withActivity(definition, activity));
    }
    registerHelpChannel(ctx, help);
    // 扩展桥与路由仍针对「用户真实浏览器」（shared），不是 per-agent 沙箱。
    // sandbox 模式下也安装：工具默认走沙箱，但 `backend: 'user'` 需要 shared 可
    // 达（以及 `@` 菜单/标签页路由读的是真实 Chrome）。cdp 后端没有扩展后端，
    // 因此不安装。
    const bridge = resolved.backend !== 'cdp'
        ? installExtensionBridge(ctx, shared, resolved.screenshotDir, resolved.bridgePort)
        : undefined;
    registerChromeRoutes(ctx, shared, resolved.screenshotDir, activity, bridge);
    registerChromeSkill(ctx);
    // 会话/子代理结束 → 释放其沙箱。
    ctx.on('agent/disposed', (payload) => {
        const id = payload.agent?.id;
        if (typeof id === 'string' && id !== '')
            registry.release(id);
    });
    ctx.on('agent/pre-step', async (_payload, next) => {
        const decision = await next();
        if (decision.kind === 'reject')
            return decision;
        const messages = await expandTabMentions(decision.messages, () => shared.listTabs());
        return messages === undefined ? decision : { ...decision, messages };
    }, { prepend: true });
    ctx.effect(() => () => {
        consoleLog.releaseAll();
        activity.clear();
        registry.dispose();
    }, 'chrome-browser: backend lifecycle');
}
//# sourceMappingURL=index.js.map