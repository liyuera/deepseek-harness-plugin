/**
 * Model-facing tool definitions for the chrome-browser plugin. Each tool is
 * one backend operation surfaced as a JSON result; errors that mean "the
 * page did not match" throw so the model sees the reason and can retry.
 * @module @liyuera/dsh-chrome-browser/tools
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { BrowserBackend } from './backend.ts';
import type { SessionBindings } from './bindings.ts';
import type { ResolvedChromeConfig } from './chrome.ts';
/** Build every chrome-browser tool definition bound to one backend. */
export declare function chromeToolDefinitions(backend: BrowserBackend, config: ResolvedChromeConfig, bindings: SessionBindings): ToolDefinition[];
//# sourceMappingURL=tools.d.ts.map