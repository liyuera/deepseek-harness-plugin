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
 * Build every chrome-browser tool definition. Each tool resolves its backend
 * from the executing agent on every call, so a sandbox backend stays scoped to
 * one agent while the extension/cdp backends keep a shared singleton. An
 * explicit per-call `backend: 'user'` opts out of the sandbox and drives the
 * shared backend (the user's real browser) instead.
 * @param resolve - maps an execution context and an optional backend preference
 *   to the browser backend the call drives.
 * @param config - the resolved plugin configuration.
 * @param consoleLog - the bounded console buffer `chrome_console` reads.
 * @param help - the human-help channel `chrome_request_help` speaks to.
 * @returns the tool definitions in registration order.
 */
export declare function chromeToolDefinitions(resolve: (exec: unknown, backend?: 'sandbox' | 'user') => BrowserBackend, config: ResolvedChromeConfig, consoleLog: ConsoleLog, help: HelpChannel): ToolDefinition[];
