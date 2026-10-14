/**
 * Model-facing tool definitions for the chrome-browser plugin. Each tool is
 * one backend operation surfaced as a JSON result; errors that mean "the
 * page did not match" throw so the model sees the reason and can retry.
 * @module @liyuera/dsh-chrome-browser/tools
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { BrowserBackend, ClickOutcome } from './backend.ts';
import type { ResolvedChromeConfig } from './chrome.ts';
import type { ConsoleLog } from './console-log.ts';
import type { HelpChannel } from './help.ts';
/**
 * Why a dispatched click may not have taken effect. `element.click()` bypasses
 * hit testing, so it fires on elements a real pointer could never reach; naming
 * those cases is what stops a caller from reading "clicked" as "the page
 * reacted".
 * @param outcome - one click's counters.
 * @returns one line per condition worth reporting; empty when every click
 *   landed on a visible, unobstructed, enabled element.
 */
export declare function clickWarnings(outcome: ClickOutcome): string[];
/**
 * Build every chrome-browser tool definition bound to one backend.
 * @param backend - the live browser backend.
 * @param config - the resolved plugin configuration.
 * @param consoleLog - the bounded console buffer `chrome_console` reads.
 * @param help - the human-help channel `chrome_request_help` speaks to.
 * @returns the tool definitions in registration order.
 */
export declare function chromeToolDefinitions(backend: BrowserBackend, config: ResolvedChromeConfig, consoleLog: ConsoleLog, help: HelpChannel): ToolDefinition[];
//# sourceMappingURL=tools.d.ts.map