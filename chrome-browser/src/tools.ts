/**
 * Model-facing tool definitions for the chrome-browser plugin. Each tool is
 * one backend operation surfaced as a JSON result; errors that mean "the
 * page did not match" throw so the model sees the reason and can retry.
 * @module @liyuera/dsh-chrome-browser/tools
 */

import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { BackendTab, BrowserBackend, ClickOutcome } from './backend.ts'
import type { ResolvedChromeConfig } from './chrome.ts'
import type { ConsoleLog } from './console-log.ts'
import type { WaitState } from './expressions.ts'
import type { HelpChannel } from './help.ts'
import {
  clickCall,
  clickResult,
  closeCall,
  closeResult,
  consoleCall,
  consoleResult,
  evalCall,
  evalResult,
  helpCall,
  helpResult,
  hoverCall,
  hoverResult,
  navigateCall,
  navigateResult,
  openCall,
  openResult,
  pressCall,
  pressResult,
  readCall,
  readResult,
  screenshotCall,
  screenshotResult,
  selectCall,
  selectResult,
  tabsCall,
  tabsResult,
  typeCall,
  typeResult,
  waitCall,
  waitResult,
  webmcpCallCall,
  webmcpCallResult,
  webmcpListCall,
  webmcpListResult,
} from './presentation.ts'
import { clipJson, clipText, normalizePageText, windowText } from './text.ts'

/** chrome_eval result serialization budget, characters. */
const EVAL_RESULT_LIMIT = 200_000

/** `chrome_wait` bound when the caller names none. */
const DEFAULT_WAIT_MS = 10_000

/** `chrome_wait` bound ceiling; a longer wait belongs in repeated calls, not one. */
const MAX_WAIT_MS = 300_000

/** Generic JSON result rendering for every tool card. */
const render = (_args: unknown, value: JsonValue): Array<{ type: 'text'; text: string }> => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
]

/**
 * The executing agent itself, for routing a human question to its own UI. A
 * delegated child cannot ask (the question service rejects it), so the value is
 * forwarded as-is rather than guessed at.
 */
function agentOf(exec: unknown): unknown {
  return (exec as { agent?: unknown }).agent
}

/** Filesystem-safe tab id for screenshot names. */
function safeTabId(tabId: string): string {
  return tabId.replace(/[^0-9a-z_-]/gi, '_')
}

/**
 * Why a dispatched click may not have taken effect. `element.click()` bypasses
 * hit testing, so it fires on elements a real pointer could never reach; naming
 * those cases is what stops a caller from reading "clicked" as "the page
 * reacted".
 * @param outcome - one click's counters.
 * @returns one line per condition worth reporting; empty when every click
 *   landed on a visible, unobstructed, enabled element.
 */
export function clickWarnings(outcome: ClickOutcome): string[] {
  const warnings: string[] = []
  if (outcome.invisible > 0) {
    warnings.push(
      `${outcome.invisible} clicked element(s) have no visible box (display:none, visibility:hidden or zero size);`
      + ' the page may have ignored the click',
    )
  }
  if (outcome.offscreen > 0) {
    warnings.push(
      `${outcome.offscreen} clicked element(s) lie outside the viewport;`
      + ' a real click would have scrolled them into view first',
    )
  }
  if (outcome.covered > 0) {
    warnings.push(
      `${outcome.covered} clicked element(s) are covered by another element at their centre;`
      + ' a real click would have landed on the covering element',
    )
  }
  if (outcome.ariaDisabled > 0) {
    warnings.push(
      `${outcome.ariaDisabled} clicked element(s) carry aria-disabled="true", which dispatches but asks consumers to ignore it`,
    )
  }
  return warnings
}

/**
 * A tab's identity after its page loaded. `openTab` reports what the tab was at
 * creation — usually an empty title — so a caller that waited for the load
 * re-reads it. A listing failure falls back to the creation view rather than
 * failing a call whose tab did open.
 * @param backend - the live browser backend.
 * @param opened - the tab as `openTab` returned it.
 * @returns the listed tab, or `opened` when the tab is gone or unlistable.
 */
async function loadedTab(backend: BrowserBackend, opened: BackendTab): Promise<BackendTab> {
  try {
    const listed = await backend.listTabs()
    return listed.find(candidate => candidate.id === opened.id) ?? opened
  } catch {
    // The follow-up lookup is a nicety; the tab itself already opened.
    return opened
  }
}

/** URL schemes the plugin can drive a page on: it injects scripts into what it opens. */
const OPERABLE_URL_SCHEMES = new Set(['http:', 'https:', 'file:'])

/**
 * Reject a URL the plugin cannot operate on, before a tab exists for it.
 *
 * `chrome_open` used to create the tab first and fail afterwards: a `data:` URL
 * produced a tab that no tool could read, evaluate, click or even navigate away
 * from, because the extension's host permissions do not cover that scheme. The
 * caller gets the reason instead of a dead tab.
 * @param tool - the tool name, for the error message.
 * @param url - the requested URL.
 */
/** Whether a URL names the blank page the plugin cannot inject into. */
function isBlankUrl(url: string): boolean {
  return url === '' || url === 'about:blank'
}

/**
 * Reject a URL whose page the plugin cannot drive.
 *
 * The privileged schemes are refused because the extension has no host
 * permission for them: the tab would be created and then fail every read,
 * evaluation and navigation. A blank page is refused only where it would
 * replace one — nothing can be injected into it either, which makes it a
 * reasonable place to start and a destructive place to end up.
 * @param tool - tool name, for the message.
 * @param url - the URL the caller asked for.
 * @param blankAllowed - whether an empty or `about:blank` URL is acceptable.
 */
function assertOperableUrl(tool: string, url: string, blankAllowed: boolean): void {
  if (isBlankUrl(url)) {
    if (blankAllowed) return
    throw new Error(
      `${tool}: about:blank cannot be driven either — the extension cannot inject into it, so navigating `
      + 'there would discard the page and leave a tab nothing can read. Close the tab instead.',
    )
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${tool}: "${url}" is not a valid URL`)
  }
  if (OPERABLE_URL_SCHEMES.has(parsed.protocol)) return
  throw new Error(
    `${tool}: cannot drive a ${parsed.protocol} URL — the plugin injects scripts into the page, which needs `
    + 'an http, https or file page. Use a real URL, or about:blank.',
  )
}

/** Extensions that name an image format, as opposed to any other file name. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'])

/**
 * Keep the caller's path but never let its extension contradict the bytes.
 *
 * The two backends produce different formats — PNG over CDP, JPEG over the
 * extension bridge — so a caller who asks for `shot.png` on the bridge would
 * otherwise get a JPEG that readers trusting the name refuse to open. A path
 * with no extension, or one this does not recognise, is left exactly as asked.
 * @param path - the caller's requested output path.
 * @param ext - the extension matching the bytes actually written.
 * @returns the path to write, with the extension corrected when it disagrees.
 */
function imagePath(path: string, ext: string): string {
  const match = /\.([A-Za-z0-9]+)$/u.exec(path)
  if (match === null) return path
  const found = (match[1] as string).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(found) || found === ext) return path
  return `${path.slice(0, match.index)}.${ext}`
}

/**
 * Resolve the tab a tool operates on: an explicit id wins, and anything else —
 * an omitted id or the literal `active` — means the tab the user is looking at.
 *
 * There is no session binding to fall back to: the `@` menu inserts a reference
 * chip and binds nothing, and the chip's `tabId` arrives in the injected context.
 */
async function resolveTabId(
  backend: BrowserBackend,
  exec: unknown,
  tabId: string | undefined,
): Promise<string> {
  if (tabId !== undefined && tabId !== '' && tabId !== 'active') return tabId
  void exec
  return backend.activeTabId()
}

/**
 * Build every chrome-browser tool definition bound to one backend.
 * @param backend - the live browser backend.
 * @param config - the resolved plugin configuration.
 * @param consoleLog - the bounded console buffer `chrome_console` reads.
 * @param help - the human-help channel `chrome_request_help` speaks to.
 * @returns the tool definitions in registration order.
 */
export function chromeToolDefinitions(
  backend: BrowserBackend,
  config: ResolvedChromeConfig,
  consoleLog: ConsoleLog,
  help: HelpChannel,
): ToolDefinition[] {
  return [
    defineTool({
      name: 'chrome_tabs',
      description:
        'List the tabs currently open in the Chrome instance the browser plugin controls: id, title, url, active and '
        + 'favicon. Get a tab id first, then pass it to every other chrome_* tool; omitting tabId (or passing '
        + '"active") means the tab the user is looking at, which is rarely the one a request names.',
      parameters: {},
      output: { schema: { type: 'json' }, render },
      isConcurrencySafe: () => true,
      presentCall: () => tabsCall(),
      presentResult: (_args, outcome) => tabsResult(outcome),
      execute: async (_args: unknown, _exec: unknown): Promise<JsonValue> => {
        const tabs = await backend.listTabs()
        return { tabs } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_read',
      description:
        'Read one tab. mode="text" (the default) returns the page title, url and visible text: the text is a window '
        + 'of readTextLimit code points (default 30000) starting at `offset`, textChars reports the whole document, '
        + 'and a truncated window carries `nextOffset` to continue from. mode="interactive" instead lists the '
        + 'elements a reader can act on — each with a ready-to-use `selector`, its role and name, and whether it is '
        + '`inView`, `disabled` or `covered` by something else. Prefer mode="interactive" before clicking or typing: '
        + 'it is far smaller than the page text and answers "what can I act on, and will it work".',
      parameters: {
        tabId: { type: 'string', description: "Tab id from chrome_tabs, or 'active' for the tab the user is looking at; omitting it means 'active' too." },
        mode: {
          type: 'string',
          enum: ['text', 'interactive'],
          description: '"text" (default) reads the page text; "interactive" lists actionable elements with their state.',
        },
        offset: { type: 'integer', description: 'Text mode: code points to skip before the window; pass the `nextOffset` a truncated read returned to continue.' },
        includeHtml: { type: 'boolean', description: 'Text mode: also return the page HTML, clipped to the same budget.' },
      },
      output: { schema: { type: 'json' }, render },
      isConcurrencySafe: () => true,
      presentCall: args => readCall(args),
      presentResult: (_args, outcome) => readResult(outcome),
      execute: async (
        args: { tabId?: string; mode?: string; offset?: number; includeHtml?: boolean },
        _exec: unknown,
      ): Promise<JsonValue> => {
        const tabId = await resolveTabId(backend, _exec, args.tabId)
        if (args.mode === 'interactive') {
          const inventory = await backend.inventory(tabId)
          return {
            tabId,
            mode: 'interactive',
            title: inventory.title,
            url: inventory.url,
            matched: inventory.matched,
            shown: inventory.items.length,
            items: inventory.items,
          } as unknown as JsonValue
        }
        const value = await backend.read(tabId, args.includeHtml === true)
        const rawText = normalizePageText(value.text)
        const window = windowText(rawText, args.offset ?? 0, config.readTextLimit)
        const html = args.includeHtml === true ? clipText(value.html, config.readTextLimit) : undefined
        return {
          tabId,
          mode: 'text',
          title: value.title,
          url: value.url,
          text: window.nextOffset === undefined
            ? window.text
            : `${window.text}\n…[window ${window.offset}-${window.nextOffset} of ${window.total} code points;`
              + ` pass offset=${window.nextOffset} for the rest]`,
          textChars: window.total,
          offset: window.offset,
          textTruncated: window.nextOffset !== undefined,
          ...(window.nextOffset === undefined ? {} : { nextOffset: window.nextOffset }),
          ...(html === undefined ? {} : { html }),
        } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_navigate',
      description:
        'Navigate one tab to a URL. By default waits until the page reaches readyState "complete" (up to waitLoadMs).',
      parameters: {
        url: {
          type: 'string',
          required: true,
          description: 'Target URL, e.g. https://example.com. http(s) and file only; a file: URL also needs the '
            + 'extension to be granted file access in chrome://extensions.',
        },
        tabId: { type: 'string', description: "Tab id from chrome_tabs, or 'active' for the tab the user is looking at; omitting it means 'active' too." },
        waitLoad: { type: 'boolean', description: 'Wait for load completion (default true).' },
      },
      output: { schema: { type: 'json' }, render },
      presentCall: args => navigateCall(args),
      presentResult: (_args, outcome) => navigateResult(outcome),
      execute: async (args: { url: string; tabId?: string; waitLoad?: boolean }, _exec: unknown): Promise<JsonValue> => {
        assertOperableUrl('chrome_navigate', args.url, false)
        const tabId = await resolveTabId(backend, _exec, args.tabId)
        await backend.navigate(tabId, args.url, args.waitLoad !== false, config.waitLoadMs)
        return { tabId, url: args.url } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_open',
      description:
        'Open a new foreground tab. By default waits until the tab reports readyState "complete" (up to waitLoadMs) '
        + 'before returning, so the returned title is the loaded page\'s and a following chrome_read sees the '
        + 'document; pass waitLoad=false to return as soon as the tab exists.',
      parameters: {
        url: {
          type: 'string',
          description: 'URL to open; defaults to about:blank. http(s) and file only — a file: URL also needs '
            + 'the extension to be granted file access in chrome://extensions, or the page will be unreadable. '
            + 'A blank tab is not readable or drivable either: open one only as a staging tab and navigate it next.',
        },
        waitLoad: { type: 'boolean', description: 'Wait for load completion (default true).' },
      },
      output: { schema: { type: 'json' }, render },
      presentCall: args => openCall(args),
      presentResult: (_args, outcome) => openResult(outcome),
      execute: async (args: { url?: string; waitLoad?: boolean }, _exec: unknown): Promise<JsonValue> => {
        const target = args.url ?? 'about:blank'
        assertOperableUrl('chrome_open', target, true)
        const opened = await backend.openTab(target)
        // A blank tab has nothing to load and nothing to read back: waiting
        // would evaluate in a page the extension cannot inject into, and the
        // identity re-read would fail the same way. Opening one is still worth
        // supporting as a staging tab for a following chrome_navigate.
        if (args.waitLoad === false || isBlankUrl(target)) {
          return { tabId: opened.id, title: opened.title, url: opened.url } as unknown as JsonValue
        }
        await backend.waitForLoad(opened.id, config.waitLoadMs)
        const loaded = await loadedTab(backend, opened)
        return { tabId: loaded.id, title: loaded.title, url: loaded.url } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_close',
      description:
        'Close one tab by id. Closing the last tab of a window closes that window. `tabId` is required and '
        + 'must be a real id from chrome_tabs: this never falls back to the active tab, because the tab the '
        + 'user is looking at is rarely the one worth closing. Close what you opened.',
      parameters: {
        tabId: { type: 'string', required: true, description: 'Exact tab id from chrome_tabs.' },
      },
      output: { schema: { type: 'json' }, render },
      presentCall: args => closeCall(args),
      presentResult: (_args, outcome) => closeResult(outcome),
      execute: async (args: { tabId?: string }, _exec: unknown): Promise<JsonValue> => {
        const tabId = args.tabId
        if (tabId === undefined || tabId === '' || tabId === 'active') {
          throw new Error(
            'chrome_close: tabId must be an exact tab id from chrome_tabs; it never defaults to the active tab',
          )
        }
        await backend.closeTab(tabId)
        return { tabId, closed: true } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_screenshot',
      description:
        'Capture one tab to an image file on the host and return its path (plus bytes and the `mime`). The format '
        + 'depends on the connection — PNG over CDP, JPEG over the extension bridge — so a `.png` a caller asks for '
        + 'becomes `.jpg` rather than a JPEG named `.png`. Use the read_image tool on the returned path to view the '
        + 'page visually. When the debugger capture fails (DevTools occupies the tab, the page refuses to render, '
        + 'the requested clip cannot be measured), the extension bridge falls back to a viewport-only capture: the '
        + 'result then carries `fallback: "visible-tab"`, a `warning`, and `viewportOnly` when `fullPage`/`selector` '
        + 'could not be honoured. If that fallback fails too, the call throws with both causes.',
      parameters: {
        tabId: { type: 'string', description: "Tab id from chrome_tabs, or 'active' for the tab the user is looking at; omitting it means 'active' too." },
        path: { type: 'string', description: 'Optional output file path; defaults to <screenshotDir>/<timestamp>-<tabId>.png.' },
        fullPage: {
          type: 'boolean',
          description: 'Capture the whole scrollable page instead of the viewport. Use it when what you need may '
            + 'sit below the fold; the image can be very tall.',
        },
        selector: {
          type: 'string',
          description: 'Capture only the element matching this CSS selector, wherever it sits on the page. '
            + 'Takes precedence over fullPage.',
        },
      },
      output: { schema: { type: 'json' }, render },
      presentCall: args => screenshotCall(args),
      presentResult: (_args, outcome) => screenshotResult(outcome),
      execute: async (
        args: { tabId?: string; path?: string; fullPage?: boolean; selector?: string },
        _exec: unknown,
      ): Promise<JsonValue> => {
        const tabId = await resolveTabId(backend, _exec, args.tabId)
        const shot = await backend.screenshot(tabId, {
          fullPage: args.fullPage === true,
          ...(typeof args.selector === 'string' && args.selector !== '' ? { selector: args.selector } : {}),
        })
        const ext = shot.mime === 'image/jpeg' ? 'jpg' : 'png'
        const path = typeof args.path === 'string' && args.path !== ''
          ? imagePath(args.path, ext)
          : join(config.screenshotDir, `${Date.now()}-${safeTabId(tabId)}.${ext}`)
        mkdirSync(dirname(path), { recursive: true })
        let bytes = 0
        if (shot.path !== undefined && shot.path !== '') {
          // Extension path: bytes already landed via the upload route.
          copyFileSync(shot.path, path)
          bytes = statSync(path).size
        } else {
          if (shot.data === '') throw new Error('chrome_screenshot returned no image data')
          const buffer = Buffer.from(shot.data, 'base64')
          writeFileSync(path, buffer)
          bytes = buffer.length
        }
        // A fallback image is still useful, so it is returned rather than
        // refused — but the caller must know it is not the capture it asked for.
        const warning = shot.fallback === 'visible-tab'
          ? `调试通道截图失败(${shot.fallbackReason ?? '原因未知'}),已退回 chrome.tabs.captureVisibleTab 的可视区域截图`
            + (shot.viewportOnly === true ? ';请求的整页/元素范围没有生效,这张只有可视区域' : '')
            + ';回退图可能是一帧旧画面,需要精确截图请关闭 DevTools/把窗口切到前台后重试'
          : undefined
        return {
          path,
          bytes,
          mime: shot.mime ?? (ext === 'jpg' ? 'image/jpeg' : 'image/png'),
          tabId,
          ...(warning === undefined
            ? {}
            : {
                fallback: 'visible-tab',
                ...(shot.viewportOnly === true ? { viewportOnly: true } : {}),
                warning,
              }),
        } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_click',
      description:
        'Click elements matching a CSS selector in one tab, through the page\'s own element.click(). Click the first '
        + 'match by default, or every match with all=true. `clicked` counts elements that received a dispatched click '
        + 'event, and `matched` counts what the selector found — a dispatched click is NOT evidence the page reacted, '
        + 'so read `warnings` when the page looks unchanged: they name elements that are hidden, outside the viewport, '
        + 'covered by another element, or marked aria-disabled. Throws when nothing matches, or when every match is '
        + 'natively disabled. Prefer this for buttons/links; use chrome_eval for interactions that need more.',
      parameters: {
        selector: { type: 'string', required: true, description: 'CSS selector, e.g. "#submit" or "a.download".' },
        tabId: { type: 'string', description: "Tab id from chrome_tabs, or 'active' for the tab the user is looking at; omitting it means 'active' too." },
        all: { type: 'boolean', description: 'Click every matching element (default false: first match only).' },
      },
      output: { schema: { type: 'json' }, render },
      presentCall: args => clickCall(args),
      presentResult: (_args, outcome) => clickResult(outcome),
      execute: async (args: { selector: string; tabId?: string; all?: boolean }, _exec: unknown): Promise<JsonValue> => {
        const tabId = await resolveTabId(backend, _exec, args.tabId)
        const outcome = await backend.click(tabId, args.selector, args.all === true)
        if (outcome.matched === 0) throw new Error(`chrome_click: no element matched selector "${args.selector}"`)
        if (outcome.clicked === 0) {
          throw new Error(
            `chrome_click: selector "${args.selector}" matched ${outcome.matched} element(s), but none was clicked`
            + ` (${outcome.disabled} natively disabled); the page did not change`,
          )
        }
        const warnings = clickWarnings(outcome)
        return {
          tabId,
          selector: args.selector,
          clicked: outcome.clicked,
          matched: outcome.matched,
          ...(warnings.length === 0 ? {} : { warnings }),
        } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_hover',
      description:
        'Hover the first element matching a CSS selector in one tab, to reveal UI that only appears on hover '
        + '(menus, tooltips, action rows). The events are synthetic, so they reach the listeners the page attached '
        + 'but do not set the browser\'s own hover state: a control revealed purely by a CSS :hover rule may stay '
        + 'hidden. Follow it with chrome_read mode="interactive" to see what appeared.',
      parameters: {
        selector: { type: 'string', required: true, description: 'CSS selector to hover, e.g. "#menu" or "[aria-label=More]".' },
        tabId: { type: 'string', description: "Tab id from chrome_tabs, or 'active' for the tab the user is looking at; omitting it means 'active' too." },
      },
      output: { schema: { type: 'json' }, render },
      presentCall: args => hoverCall(args),
      presentResult: (_args, outcome) => hoverResult(outcome),
      execute: async (args: { selector: string; tabId?: string }, _exec: unknown): Promise<JsonValue> => {
        const tabId = await resolveTabId(backend, _exec, args.tabId)
        const outcome = await backend.hover(tabId, args.selector)
        if (outcome.matched === 0) throw new Error(`chrome_hover: no element matched selector "${args.selector}"`)
        return { tabId, selector: args.selector, hovered: outcome.hovered } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_type',
      description:
        'Type text into the element matching a CSS selector in one tab. Focuses the element, selects its existing '
        + 'content (clear=true, the default, so the text replaces it), then sets the value with a native-setter '
        + 'input/change dispatch so React-style controlled fields update.',
      parameters: {
        selector: { type: 'string', required: true, description: 'CSS selector of the input/textarea/editable element.' },
        text: { type: 'string', required: true, description: 'Text to insert.' },
        tabId: { type: 'string', description: "Tab id from chrome_tabs, or 'active' for the tab the user is looking at; omitting it means 'active' too." },
        clear: { type: 'boolean', description: 'Select existing content first so the text replaces it (default true).' },
      },
      output: { schema: { type: 'json' }, render },
      presentCall: args => typeCall(args),
      presentResult: (_args, outcome) => typeResult(outcome),
      execute: async (args: { selector: string; text: string; tabId?: string; clear?: boolean }, _exec: unknown): Promise<JsonValue> => {
        const tabId = await resolveTabId(backend, _exec, args.tabId)
        const cleared = args.clear !== false
        await backend.type(tabId, args.selector, args.text, cleared)
        return { tabId, selector: args.selector, text: args.text, cleared } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_press',
      description:
        'Press one key in a tab, optionally focusing a CSS selector first: Enter to submit, Escape to close a dialog, '
        + 'Tab or an arrow key to move through a menu. The events are synthetic, so the browser performs no default '
        + 'action — for Enter the owning form is submitted explicitly and `submitted: true` says that happened. A key '
        + 'that only moves focus or closes an overlay reports `submitted: false` and changes nothing else.',
      parameters: {
        key: { type: 'string', required: true, description: 'KeyboardEvent.key value, e.g. "Enter", "Escape", "Tab", "ArrowDown".' },
        selector: { type: 'string', description: 'Focus this element first; omit to press on whatever currently has focus.' },
        tabId: { type: 'string', description: "Tab id from chrome_tabs, or 'active' for the tab the user is looking at; omitting it means 'active' too." },
      },
      output: { schema: { type: 'json' }, render },
      presentCall: args => pressCall(args),
      presentResult: (_args, outcome) => pressResult(outcome),
      execute: async (args: { key: string; selector?: string; tabId?: string }, _exec: unknown): Promise<JsonValue> => {
        const tabId = await resolveTabId(backend, _exec, args.tabId)
        const outcome = await backend.press(tabId, args.key, args.selector)
        if (!outcome.found) {
          throw new Error(`chrome_press: no element matched selector "${args.selector ?? ''}" to focus`)
        }
        return {
          tabId,
          key: args.key,
          selector: args.selector ?? null,
          pressed: outcome.pressed,
          submitted: outcome.submitted,
        } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_select',
      description:
        'Choose an option in a <select> by its option VALUE, not its visible label. Sets the value through the '
        + 'prototype setter and fires input/change so controlled components update. Throws when the value is not one '
        + 'of the options, listing the values that are — read them from the error rather than guessing again.',
      parameters: {
        selector: { type: 'string', required: true, description: 'CSS selector for the <select> element.' },
        value: { type: 'string', required: true, description: 'Option value to select (the value attribute, not the label).' },
        tabId: { type: 'string', description: "Tab id from chrome_tabs, or 'active' for the tab the user is looking at; omitting it means 'active' too." },
      },
      output: { schema: { type: 'json' }, render },
      presentCall: args => selectCall(args),
      presentResult: (_args, outcome) => selectResult(outcome),
      execute: async (args: { selector: string; value: string; tabId?: string }, _exec: unknown): Promise<JsonValue> => {
        const tabId = await resolveTabId(backend, _exec, args.tabId)
        const outcome = await backend.select(tabId, args.selector, args.value)
        if (outcome.matched === 0) {
          throw new Error(`chrome_select: no element matched selector "${args.selector}"`)
        }
        if (outcome.reason !== undefined) {
          throw new Error(
            `chrome_select: "${args.selector}" is ${outcome.reason}; use chrome_type for text inputs`
            + ' or chrome_click for custom dropdowns',
          )
        }
        if (!outcome.changed) {
          const available = outcome.options.length === 0 ? '(the control has no options)' : outcome.options.join(', ')
          throw new Error(
            `chrome_select: "${args.selector}" has no option with value "${args.value}"; available values: ${available}`,
          )
        }
        return { tabId, selector: args.selector, value: outcome.value } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_eval',
      description:
        'Evaluate a JavaScript expression in one tab\'s page context and return its value as JSON text '
        + '(bounded to 200k characters). Expression runs in the page\'s main world; returned values are '
        + 'serialized by value. Example: document.querySelectorAll("a").length.',
      parameters: {
        expression: { type: 'string', required: true, description: 'JavaScript expression to evaluate in the page.' },
        tabId: { type: 'string', description: "Tab id from chrome_tabs, or 'active' for the tab the user is looking at; omitting it means 'active' too." },
      },
      output: { schema: { type: 'json' }, render },
      presentCall: args => evalCall(args),
      presentResult: (_args, outcome) => evalResult(outcome),
      execute: async (args: { expression: string; tabId?: string }, _exec: unknown): Promise<JsonValue> => {
        const tabId = await resolveTabId(backend, _exec, args.tabId)
        const value = await backend.evaluate(tabId, args.expression)
        return {
          tabId,
          value: clipJson(value, EVAL_RESULT_LIMIT),
          // Absent on the normal route; present when the page's CSP forced the
          // expression through the debugger protocol instead.
          ...(backend.lastEvalWorld === 'debugger' ? { world: 'debugger' } : {}),
        } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_webmcp_list',
      description:
        'List the WebMCP tools the page in one tab declares. A WebMCP page exposes structured tools (name, '
        + 'description, JSON Schema input, safety annotations) that the page itself executes, which is far more '
        + 'reliable than guessing at DOM clicks — check this before chrome_read/chrome_click when the page may '
        + 'implement WebMCP. `available: false` means the browser has no WebMCP surface (Chrome needs '
        + '--enable-features=WebMCP or an origin trial) or listing failed — fall back to the DOM tools. '
        + '`available: true` with an empty `tools` array means the page has the API but registers no tools right now.',
      parameters: {
        tabId: { type: 'string', description: "Tab id from chrome_tabs, or 'active' for the tab the user is looking at; omitting it means 'active' too." },
      },
      output: { schema: { type: 'json' }, render },
      isConcurrencySafe: () => true,
      presentCall: args => webmcpListCall(args),
      presentResult: (_args, outcome) => webmcpListResult(outcome),
      execute: async (args: { tabId?: string }, _exec: unknown): Promise<JsonValue> => {
        const tabId = await resolveTabId(backend, _exec, args.tabId)
        const listing = await backend.webmcpTools(tabId)
        return {
          tabId,
          available: listing.available,
          tools: listing.tools,
          ...(listing.reason === undefined ? {} : { reason: listing.reason }),
        } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_webmcp_call',
      description:
        'Execute one WebMCP tool the page declares (see chrome_webmcp_list). `input` is the tool\'s JSON Schema '
        + 'arguments. `pending: true` means the page activated the tool but it has not settled — declarative form '
        + 'tools wait for the user to click Submit; do not call it again, ask the user first. `navigated: true` '
        + 'means the call changed the page. `result` is the page\'s returned value: Chrome serializes structured '
        + 'returns to JSON TEXT, so JSON.parse it before reading fields; a plain-text return stays text. '
        + 'Respect consequentialHint: confirm with the user '
        + '(chrome_request_help) before high-stakes tools.',
      parameters: {
        name: { type: 'string', required: true, description: '工具名,来自 chrome_webmcp_list 的 name。' },
        input: { type: 'object', additionalProperties: true, description: '该工具 inputSchema 对应的参数对象;不需要参数时省略。' },
        tabId: { type: 'string', description: "Tab id from chrome_tabs, or 'active' for the tab the user is looking at; omitting it means 'active' too." },
      },
      output: { schema: { type: 'json' }, render },
      presentCall: args => webmcpCallCall(args),
      presentResult: (_args, outcome) => webmcpCallResult(outcome),
      execute: async (
        args: { name: string; input?: Record<string, unknown>; tabId?: string },
        _exec: unknown,
      ): Promise<JsonValue> => {
        const tabId = await resolveTabId(backend, _exec, args.tabId)
        const input = typeof args.input === 'object' && args.input !== null && !Array.isArray(args.input) ? args.input : {}
        const outcome = await backend.webmcpCall(tabId, args.name, input)
        return {
          tabId,
          tool: outcome.tool,
          ...(outcome.pending === true
            ? { pending: true, ...(outcome.note === undefined ? {} : { note: outcome.note }) }
            : {}),
          ...(outcome.navigated === true ? { navigated: true } : {}),
          ...(outcome.pending === true || outcome.navigated === true || outcome.result === undefined
            ? {}
            : {
                // Chrome already serializes object returns to a JSON STRING. Clipping
                // that text keeps the model-facing value one JSON layer deep; running
                // clipJson on it again would escape the text a second time.
                result: typeof outcome.result === 'string'
                  ? clipText(outcome.result, EVAL_RESULT_LIMIT)
                  : clipJson(outcome.result, EVAL_RESULT_LIMIT),
              }),
        } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_wait',
      description:
        'Wait for an element condition in one tab before acting on it — the way to handle a page that renders '
        + 'asynchronously, instead of reading too early. `state` defaults to "visible"; "hidden" also covers an '
        + 'element that is absent. The result says `satisfied`: **false means the timeout passed, not that the wait '
        + 'succeeded** — check it before assuming the page is ready.',
      parameters: {
        selector: { type: 'string', required: true, description: 'CSS selector to wait for.' },
        state: {
          type: 'string',
          enum: ['visible', 'hidden', 'attached', 'detached'],
          description: '"visible" (default): present with a layout box and not hidden. "hidden": absent or not shown. "attached"/"detached": presence only.',
        },
        timeoutMs: { type: 'integer', description: 'How long to wait (default 10000ms; max 300000).' },
        tabId: { type: 'string', description: "Tab id from chrome_tabs, or 'active' for the tab the user is looking at; omitting it means 'active' too." },
      },
      output: { schema: { type: 'json' }, render },
      presentCall: args => waitCall(args),
      presentResult: (_args, outcome) => waitResult(outcome),
      execute: async (
        args: { selector: string; state?: string; timeoutMs?: number; tabId?: string },
        _exec: unknown,
      ): Promise<JsonValue> => {
        const tabId = await resolveTabId(backend, _exec, args.tabId)
        const state: WaitState = args.state === 'hidden' || args.state === 'attached' || args.state === 'detached'
          ? args.state
          : 'visible'
        const timeoutMs = Math.min(Math.max(args.timeoutMs ?? DEFAULT_WAIT_MS, 0), MAX_WAIT_MS)
        const started = Date.now()
        const satisfied = await backend.waitFor(tabId, args.selector, state, timeoutMs)
        return {
          tabId,
          selector: args.selector,
          state,
          satisfied,
          elapsedMs: Date.now() - started,
        } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_request_help',
      description:
        'Ask the user to do a step only they can do — sign in, solve a CAPTCHA, approve a prompt, finish 2FA — and '
        + 'wait until they answer. Use it instead of guessing at a login wall or retrying a page you cannot get '
        + 'past. `completed: false` means they declined or dismissed it: stop that line of work rather than trying '
        + 'again. After `completed: true`, re-read the page to see the new state before continuing.',
      parameters: {
        reason: {
          type: 'string',
          required: true,
          description: 'What the user must do, in their own language, naming the page or site so they know where to look.',
        },
      },
      output: { schema: { type: 'json' }, render },
      presentCall: args => helpCall(args),
      presentResult: (_args, outcome) => helpResult(outcome),
      execute: async (args: { reason: string }, _exec: unknown): Promise<JsonValue> => {
        const outcome = await help.request(args.reason, agentOf(_exec))
        return {
          completed: outcome.completed,
          ...(outcome.note === undefined ? {} : { note: outcome.note }),
        } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_console',
      description:
        'Read the JavaScript console of one tab. Capture must be running BEFORE the page does the thing you want to '
        + 'observe, because nothing is recorded retroactively: action=start attaches the debugger and buffers (Chrome '
        + 'shows a "debugging this browser" bar on that tab until action=stop), action=read returns entries after '
        + '`since` together with a `cursor` to pass as the next `since`, and action=stop ends capture and drops the '
        + 'buffer. Browser-raised messages (failed requests, CSP refusals, deprecations) are included — a wrapper '
        + 'around console() would miss them. The buffer is bounded per tab and never written to the session log; '
        + '`dropped` counts entries evicted before you read them.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['start', 'stop', 'read'],
          description: 'start capture, read entries, or stop and drop the buffer.',
        },
        tabId: { type: 'string', description: "Tab id from chrome_tabs, or 'active' for the tab the user is looking at; omitting it means 'active' too." },
        since: { type: 'integer', description: 'Read: return entries whose sequence number is greater than this cursor (default 0 = everything retained).' },
        limit: { type: 'integer', description: 'Read: keep only the most recent N matching entries.' },
      },
      output: { schema: { type: 'json' }, render },
      presentCall: args => consoleCall(args),
      presentResult: (_args, outcome) => consoleResult(outcome),
      execute: async (args: { action: string; tabId?: string; since?: number; limit?: number }, _exec: unknown): Promise<JsonValue> => {
        const tabId = await resolveTabId(backend, _exec, args.tabId)
        if (args.action === 'start') {
          await backend.startConsole(tabId)
          consoleLog.track(tabId)
          return { tabId, capturing: true, capturingTabs: consoleLog.tracked() } as unknown as JsonValue
        }
        if (args.action === 'stop') {
          await backend.stopConsole(tabId)
          consoleLog.release(tabId)
          return { tabId, capturing: false } as unknown as JsonValue
        }
        const page = consoleLog.read(tabId, {
          ...(args.since === undefined ? {} : { since: args.since }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        })
        if (page === undefined) {
          throw new Error(
            `chrome_console: tab ${tabId} is not being captured; call action=start BEFORE the page does the thing`
            + ' you want to observe, then action=read',
          )
        }
        return {
          tabId,
          entries: page.entries,
          retained: page.retained,
          dropped: page.dropped,
          cursor: page.cursor,
        } as unknown as JsonValue
      },
    }),
  ]
}
