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
import { ActivityTracker, withActivity } from "./activity.js";
import { buildBackend } from "./backend.js";
import { DEFAULT_BRIDGE_PORT, DEFAULT_CONSOLE_IDLE_MS, resolveChromeConfig } from "./chrome.js";
import { ConsoleLog } from "./console-log.js";
import { installExtensionBridge } from "./bridge.js";
import { HelpChannel, registerHelpChannel } from "./help.js";
import { expandTabMentions } from "./mentions.js";
import { registerChromeRoutes } from "./routes.js";
import { registerChromeSkill } from "./skill.js";
import { chromeToolDefinitions } from "./tools.js";
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
    consoleIdleMs: z.number().step(1).min(0).default(DEFAULT_CONSOLE_IDLE_MS),
    bridgePort: z.number().step(1).min(0).max(65535).default(DEFAULT_BRIDGE_PORT),
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
    const { backend, chrome } = buildBackend(resolved, (tabId, message) => {
        consoleLog.append(tabId, message);
    });
    if (chrome !== undefined)
        chrome.reclaimOwnedLeftover();
    // The help channel reaches the user through the harness's question service;
    // it stays unwired (and says so) when this composition has none.
    const help = new HelpChannel();
    // Every tool execution is recorded here so the browser half can show what the
    // agent is doing without reading the session stream itself.
    const activity = new ActivityTracker();
    for (const definition of chromeToolDefinitions(backend, resolved, consoleLog, help)) {
        ctx.tools.register(withActivity(definition, activity));
    }
    registerHelpChannel(ctx, help);
    // Only the extension backend has a bridge to keep on its fixed port.
    const bridge = resolved.backend === 'extension'
        ? installExtensionBridge(ctx, backend, resolved.screenshotDir, resolved.bridgePort)
        : undefined;
    registerChromeRoutes(ctx, backend, resolved.screenshotDir, activity, bridge);
    registerChromeSkill(ctx);
    // A message citing tabs gains one context message carrying their URLs and
    // ids. Only the messages this step admits are scanned, and the context
    // message's own source keeps it out of the next scan.
    ctx.on('agent/pre-step', async (_payload, next) => {
        const decision = await next();
        if (decision.kind === 'reject')
            return decision;
        const messages = await expandTabMentions(decision.messages, () => backend.listTabs());
        return messages === undefined ? decision : { ...decision, messages };
    }, { prepend: true });
    ctx.effect(() => () => {
        consoleLog.releaseAll();
        activity.clear();
        backend.dispose();
    }, 'chrome-browser: backend lifecycle');
}
//# sourceMappingURL=index.js.map