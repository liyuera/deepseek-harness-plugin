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
import z from '@deepseek-ai/schemastery';
import { buildBackend } from "./backend.js";
import { SessionBindings } from "./bindings.js";
import { resolveChromeConfig } from "./chrome.js";
import { expandTabMentions } from "./mentions.js";
import { registerChromeRoutes } from "./routes.js";
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
    const { backend, chrome } = buildBackend(resolved);
    if (chrome !== undefined)
        chrome.reclaimOwnedLeftover();
    const bindings = new SessionBindings();
    for (const definition of chromeToolDefinitions(backend, resolved, bindings)) {
        ctx.tools.register(definition);
    }
    registerChromeRoutes(ctx, backend, bindings, config.screenshotDir ?? resolveChromeConfig(config).screenshotDir);
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
    ctx.effect(() => () => backend.dispose(), 'chrome-browser: backend lifecycle');
}
//# sourceMappingURL=index.js.map