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
import type { BrowserBackend } from './backend.ts'
import type { SessionBindings } from './bindings.ts'
import type { ResolvedChromeConfig } from './chrome.ts'
import { clipJson, clipText, normalizePageText } from './text.ts'

/** chrome_eval result serialization budget, characters. */
const EVAL_RESULT_LIMIT = 200_000

/** Generic JSON result rendering for every tool card. */
const render = (_args: unknown, value: JsonValue): Array<{ type: 'text'; text: string }> => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
]

/** The executing agent's session id (minimal face; exec is a ToolRunContext). */
function sessionIdOf(exec: unknown): string | undefined {
  const agent = (exec as { agent?: { session?: { id?: unknown } } }).agent
  const id = agent?.session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** Filesystem-safe tab id for screenshot names. */
function safeTabId(tabId: string): string {
  return tabId.replace(/[^0-9a-z_-]/gi, '_')
}

/**
 * Resolve the tab a tool operates on: explicit id wins, then the
 * session-bound tab, then the active tab.
 */
async function resolveTabId(
  backend: BrowserBackend,
  bindings: SessionBindings,
  exec: unknown,
  tabId: string | undefined,
): Promise<string> {
  if (tabId !== undefined && tabId !== '' && tabId !== 'active') return tabId
  const sessionId = sessionIdOf(exec)
  if (tabId !== 'active' && sessionId !== undefined) {
    const bound = bindings.get(sessionId)
    if (bound !== undefined) {
      const tabs = await backend.listTabs()
      if (tabs.some(tab => tab.id === bound)) return bound
    }
  }
  return backend.activeTabId()
}

/** Build every chrome-browser tool definition bound to one backend. */
export function chromeToolDefinitions(
  backend: BrowserBackend,
  config: ResolvedChromeConfig,
  bindings: SessionBindings,
): ToolDefinition[] {
  return [
    defineTool({
      name: 'chrome_tabs',
      description:
        'List the tabs currently open in the Chrome instance the browser plugin controls: id, title, url, active and '
        + 'favicon, plus every tab this session selected (`session.tabs`, first = the default). Get a tab id first, '
        + 'then pass it to chrome_read/chrome_navigate/chrome_screenshot/chrome_click/chrome_type/chrome_eval; omit '
        + 'tabId to use the first session-selected tab, or "active" for the active tab.',
      parameters: {},
      output: { schema: { type: 'json' }, render },
      execute: async (_args: unknown, _exec: unknown): Promise<JsonValue> => {
        const tabs = await backend.listTabs()
        let session: { tabIds: string[]; tabs: Array<{ id: string; title: string; url: string }> } | null = null
        const sessionId = sessionIdOf(_exec)
        if (sessionId !== undefined) {
          const boundIds = bindings.all(sessionId)
          if (boundIds.length > 0) {
            const picked = boundIds
              .map(id => tabs.find(candidate => candidate.id === id))
              .filter((tab): tab is NonNullable<typeof tab> => tab !== undefined)
            if (picked.length > 0) {
              session = {
                tabIds: picked.map(tab => tab.id),
                tabs: picked.map(tab => ({ id: tab.id, title: tab.title, url: tab.url })),
              }
            }
          }
        }
        return { tabs, session } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_read',
      description:
        'Read one tab: page title, url and the visible text. The text is clipped to the configured readTextLimit '
        + '(default 30000 code points); textChars reports the full count.',
      parameters: {
        tabId: { type: 'string', description: "Tab id from chrome_tabs; omit to use the session-selected tab, or 'active' for the active tab." },
        includeHtml: { type: 'boolean', description: 'Also return the page HTML, clipped to the same budget.' },
      },
      output: { schema: { type: 'json' }, render },
      execute: async (args: { tabId?: string; includeHtml?: boolean }, _exec: unknown): Promise<JsonValue> => {
        const tabId = await resolveTabId(backend, bindings, _exec, args.tabId)
        const value = await backend.read(tabId, args.includeHtml === true)
        const rawText = normalizePageText(value.text)
        const clipped = clipText(rawText, config.readTextLimit)
        const html = args.includeHtml === true ? clipText(value.html, config.readTextLimit) : undefined
        return {
          tabId,
          title: value.title,
          url: value.url,
          text: clipped,
          textChars: Array.from(rawText).length,
          textTruncated: clipped !== rawText,
          ...(html === undefined ? {} : { html }),
        } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_navigate',
      description:
        'Navigate one tab to a URL. By default waits until the page reaches readyState "complete" (up to waitLoadMs).',
      parameters: {
        url: { type: 'string', required: true, description: 'Target URL, e.g. https://example.com.' },
        tabId: { type: 'string', description: "Tab id from chrome_tabs; omit to use the session-selected tab, or 'active' for the active tab." },
        waitLoad: { type: 'boolean', description: 'Wait for load completion (default true).' },
      },
      output: { schema: { type: 'json' }, render },
      execute: async (args: { url: string; tabId?: string; waitLoad?: boolean }, _exec: unknown): Promise<JsonValue> => {
        const tabId = await resolveTabId(backend, bindings, _exec, args.tabId)
        await backend.navigate(tabId, args.url, args.waitLoad !== false, config.waitLoadMs)
        return { tabId, url: args.url } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_open',
      description: 'Open a new foreground tab. Returns its tab id for later tools.',
      parameters: {
        url: { type: 'string', description: 'URL to open; defaults to about:blank.' },
      },
      output: { schema: { type: 'json' }, render },
      execute: async (args: { url?: string }, _exec: unknown): Promise<JsonValue> => {
        const tab = await backend.openTab(args.url ?? 'about:blank')
        return { tabId: tab.id, title: tab.title, url: tab.url } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_screenshot',
      description:
        'Capture one tab as a PNG file on the host and return its path (plus bytes). Use the read_image tool on the '
        + 'returned path to view the page visually.',
      parameters: {
        tabId: { type: 'string', description: "Tab id from chrome_tabs; omit to use the session-selected tab, or 'active' for the active tab." },
        path: { type: 'string', description: 'Optional output file path; defaults to <screenshotDir>/<timestamp>-<tabId>.png.' },
      },
      output: { schema: { type: 'json' }, render },
      execute: async (args: { tabId?: string; path?: string }, _exec: unknown): Promise<JsonValue> => {
        const tabId = await resolveTabId(backend, bindings, _exec, args.tabId)
        const shot = await backend.screenshot(tabId)
        const ext = shot.mime === 'image/jpeg' ? 'jpg' : 'png'
        const path = typeof args.path === 'string' && args.path !== ''
          ? args.path
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
        return { path, bytes, tabId } as unknown as JsonValue
      },
    }),

    defineTool({
      name: 'chrome_click',
      description:
        'Click elements matching a CSS selector in one tab. Click the first match by default, or every match with '
        + 'all=true. Throws when no element matches. Prefer this for buttons/links; use chrome_eval for interactions '
        + 'that need more.',
      parameters: {
        selector: { type: 'string', required: true, description: 'CSS selector, e.g. "#submit" or "a.download".' },
        tabId: { type: 'string', description: "Tab id from chrome_tabs; omit to use the session-selected tab, or 'active' for the active tab." },
        all: { type: 'boolean', description: 'Click every matching element (default false: first match only).' },
      },
      output: { schema: { type: 'json' }, render },
      execute: async (args: { selector: string; tabId?: string; all?: boolean }, _exec: unknown): Promise<JsonValue> => {
        const tabId = await resolveTabId(backend, bindings, _exec, args.tabId)
        const count = await backend.click(tabId, args.selector, args.all === true)
        if (count === 0) throw new Error(`chrome_click: no element matched selector "${args.selector}"`)
        return { tabId, selector: args.selector, clicked: count } as unknown as JsonValue
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
        tabId: { type: 'string', description: "Tab id from chrome_tabs; omit to use the session-selected tab, or 'active' for the active tab." },
        clear: { type: 'boolean', description: 'Select existing content first so the text replaces it (default true).' },
      },
      output: { schema: { type: 'json' }, render },
      execute: async (args: { selector: string; text: string; tabId?: string; clear?: boolean }, _exec: unknown): Promise<JsonValue> => {
        const tabId = await resolveTabId(backend, bindings, _exec, args.tabId)
        const cleared = args.clear !== false
        await backend.type(tabId, args.selector, args.text, cleared)
        return { tabId, selector: args.selector, text: args.text, cleared } as unknown as JsonValue
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
        tabId: { type: 'string', description: "Tab id from chrome_tabs; omit to use the session-selected tab, or 'active' for the active tab." },
      },
      output: { schema: { type: 'json' }, render },
      execute: async (args: { expression: string; tabId?: string }, _exec: unknown): Promise<JsonValue> => {
        const tabId = await resolveTabId(backend, bindings, _exec, args.tabId)
        const value = await backend.evaluate(tabId, args.expression)
        return { tabId, value: clipJson(value, EVAL_RESULT_LIMIT) } as unknown as JsonValue
      },
    }),
  ]
}
