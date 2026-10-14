/**
 * UI presentation and concurrency classification of the chrome_* tools. These
 * are the parts the model never sees: cards render in the DSH UI, and the
 * classifier decides whether two calls may overlap.
 *
 * Every presenter is reached through the registry's soft argument validation,
 * so a call whose logged arguments no longer match the schema silently renders
 * generically (`undefined`) instead of throwing on replay. These tests drive
 * each presenter with valid arguments and pin that fallback separately.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolCallView, ToolDefinition, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { BackendInventory, BackendRead, BackendTab, BrowserBackend, ClickOutcome } from '../src/backend.ts'
import { resolveChromeConfig } from '../src/chrome.ts'
import type { ResolvedChromeConfig } from '../src/chrome.ts'
import { ConsoleLog } from '../src/console-log.ts'
import { HelpChannel } from '../src/help.ts'
import { CARD_TAB_LIMIT, tabLabel } from '../src/presentation.ts'
import { chromeToolDefinitions } from '../src/tools.ts'

/** Every tool name the plugin registers, in definition order. */
const TOOL_NAMES = [
  'chrome_tabs',
  'chrome_read',
  'chrome_navigate',
  'chrome_open',
  'chrome_close',
  'chrome_screenshot',
  'chrome_click',
  'chrome_hover',
  'chrome_type',
  'chrome_press',
  'chrome_select',
  'chrome_eval',
  'chrome_wait',
  'chrome_request_help',
  'chrome_console',
] as const

/** Tools that only observe: they may run alongside sibling calls. */
const PARALLEL_SAFE = ['chrome_tabs', 'chrome_read']

/** Arguments that satisfy each tool's schema, for the presenter tests. */
const SAMPLE_ARGS: Record<(typeof TOOL_NAMES)[number], unknown> = {
  chrome_tabs: {},
  chrome_read: { tabId: '1' },
  chrome_navigate: { url: 'https://example.test/a' },
  chrome_open: { url: 'https://example.test/new' },
  chrome_close: { tabId: '1' },
  chrome_screenshot: { tabId: '1' },
  chrome_click: { selector: 'a.next' },
  chrome_hover: { selector: '#menu' },
  chrome_type: { selector: '#pw', text: 'hunter2' },
  chrome_press: { key: 'Enter' },
  chrome_select: { selector: '#country', value: 'CA' },
  chrome_eval: { expression: 'document.title' },
  chrome_wait: { selector: '#ready' },
  chrome_request_help: { reason: '请登录' },
  chrome_console: { action: 'read' },
}

/** A click that matched nothing; cards are driven by synthetic outcomes. */
const EMPTY_CLICK: ClickOutcome = {
  matched: 0, clicked: 0, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0,
}

function tab(id: string, overrides: Partial<BackendTab> = {}): BackendTab {
  return { id, title: `tab ${id}`, url: `https://example.test/${id}`, active: false, favicon: '', ...overrides }
}

/** A backend that answers with fixed values; tests override the operation they exercise. */
function fakeBackend(overrides: Partial<BrowserBackend> = {}): BrowserBackend {
  return {
    lastEvalWorld: undefined,
    ensure: async () => {},
    activeTabId: async () => '1',
    listTabs: async () => [],
    openTab: async (url: string) => tab('9', { url, title: '新标签页', active: true }),
    closeTab: async () => {},
    read: async (): Promise<BackendRead> => ({ title: '', url: '', text: '', html: '' }),
    inventory: async (): Promise<BackendInventory> => ({ title: '', url: '', matched: 0, items: [] }),
    navigate: async () => {},
    waitForLoad: async () => {},
    evaluate: async () => undefined,
    click: async () => EMPTY_CLICK,
    hover: async () => ({ matched: 0, hovered: false }),
    press: async () => ({ found: true, pressed: true, submitted: false }),
    select: async () => ({ matched: 1, changed: true, value: 'x', options: ['x'] }),
    waitFor: async () => false,
    type: async () => {},
    screenshot: async () => ({ data: '' }),
    startConsole: async () => {},
    stopConsole: async () => {},
    dispose: () => {},
    ...overrides,
  }
}

function definitions(
  backend: BrowserBackend = fakeBackend(),
  config: Partial<ResolvedChromeConfig> = {},
): Map<string, ToolDefinition> {
  const resolved = resolveChromeConfig(config)
  return new Map(
    chromeToolDefinitions(backend, resolved, new ConsoleLog(), new HelpChannel())
      .map(definition => [definition.name, definition]),
  )
}

/** The settled result a tool produces for one canonical value. */
function outcome(value: unknown): ToolResult {
  return { isError: false, content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

/** The card body text, or an empty string when the card carries none. */
function body(view: ToolResultView | undefined): string {
  // Only the generic card carries a `content` array; the specialised ones do not.
  const block = view?.card === 'generic' ? view.content?.[0] : undefined
  return block !== undefined && block.type === 'text' ? block.text : ''
}

/** The serialized card, for negative assertions. */
function serialized(view: ToolCallView | ToolResultView | undefined): string {
  return JSON.stringify(view)
}

describe('concurrency classification', () => {
  it('registers exactly the fifteen chrome tools', () => {
    expect([...definitions().keys()]).toEqual([...TOOL_NAMES])
  })

  it('lets only the observing tools run in parallel', () => {
    const registered = definitions()
    const parallel = [...registered.values()]
      .filter(definition => definition.isConcurrencySafe?.(SAMPLE_ARGS[definition.name as never]) === true)
      .map(definition => definition.name)
    expect(parallel).toEqual(PARALLEL_SAFE)
  })

  it('never classifies a page-mutating tool as parallel-safe', () => {
    const registered = definitions()
    for (const name of TOOL_NAMES.filter(candidate => !PARALLEL_SAFE.includes(candidate))) {
      expect(registered.get(name)?.isConcurrencySafe?.(SAMPLE_ARGS[name]) ?? false).toBe(false)
    }
  })
})

describe('soft argument validation', () => {
  // The registry validates presenter arguments against the current schema and
  // falls back to the generic presentation, because a card may be replayed from
  // logged arguments that an older schema produced.
  const stale = outcome({ tabId: '1', selector: 'a.next', clicked: 3 })

  it('renders no card when the arguments no longer validate', () => {
    expect(definitions().get('chrome_click')?.presentResult?.({}, stale)).toBeUndefined()
    expect(definitions().get('chrome_click')?.presentCall?.({})).toBeUndefined()
  })

  it('falls back to exclusive for a declaring tool whose arguments no longer validate', () => {
    // chrome_read declares a classifier; a logged call whose tabId is no longer
    // a string must not be treated as parallel-safe.
    expect(definitions().get('chrome_read')?.isConcurrencySafe?.({ tabId: 42 })).toBe(false)
  })

  it('leaves a mutating tool without a classifier at all', () => {
    // chrome_click declares none. The registry's `executionMode` reads absent,
    // unknown and throwing classifiers as exclusive, so omitting it is the
    // fail-closed choice rather than an oversight.
    const click = definitions().get('chrome_click')
    expect(click?.isConcurrencySafe).toBeUndefined()
    expect(click?.isConcurrencySafe?.(SAMPLE_ARGS.chrome_click) ?? false).toBe(false)
  })
})

describe('pending call titles', () => {
  it('names the target tab when the call carries one', () => {
    const read = definitions().get('chrome_read')
    expect(read?.presentCall?.({ tabId: '42' })?.title).toBe('读取标签页 42')
    expect(read?.presentCall?.({ tabId: 'active' })?.title).toBe('读取标签页 活动标签页')
    expect(read?.presentCall?.({})?.title).toBe('读取标签页 当前标签页')
  })

  it('titles a navigation with its destination', () => {
    const view = definitions().get('chrome_navigate')?.presentCall?.({ url: 'https://example.test/a', waitLoad: true })
    expect(view).toMatchObject({ card: 'generic', kind: 'fetch', title: '导航到 https://example.test/a' })
  })

  it('keeps a long selector out of the title', () => {
    const selector = `#${'x'.repeat(200)}`
    const view = definitions().get('chrome_click')?.presentCall?.({ selector })
    expect(view?.title.length).toBeLessThan(80)
    expect(view?.title).toContain('点击')
  })

  it('counts the characters a type call will insert without showing them', () => {
    const view = definitions().get('chrome_type')?.presentCall?.({ selector: '#pw', text: 'hunter2' })
    expect(view?.title).toBe('输入 7 字符到 #pw')
    expect(serialized(view)).not.toContain('hunter2')
  })

  it('puts an evaluated expression in the expandable raw input, not the title', () => {
    const view = definitions().get('chrome_eval')?.presentCall?.({ expression: 'document.title' })
    expect(view).toMatchObject({ kind: 'execute', rawInput: 'document.title' })
    expect(view?.title).toBe('执行 JS 当前标签页')
  })
})

describe('completed cards', () => {
  it('lists tabs, marks the active one and caps the rows', async () => {
    const tabs = Array.from({ length: CARD_TAB_LIMIT + 3 }, (_, index) => tab(String(index), { active: index === 0 }))
    const tool = definitions(fakeBackend({ listTabs: async () => tabs })).get('chrome_tabs')
    const value = await tool?.execute({}, {} as never)
    const view = tool?.presentResult?.({}, outcome(value))

    expect(view?.title).toBe(`${CARD_TAB_LIMIT + 3} 个标签页`)
    expect(body(view).startsWith('▶ tab 0')).toBe(true)
    expect(body(view)).toContain('· tab 1')
    expect(body(view)).not.toContain(`tab ${CARD_TAB_LIMIT}`)
    expect(body(view)).toContain('另有 3 个标签页')
  })

  it('leads a read card with the page identity and keeps the model-facing text', async () => {
    const backend = fakeBackend({
      read: async () => ({ title: '示例页面', url: 'https://example.test/page', text: '正文内容', html: '' }),
    })
    const tool = definitions(backend).get('chrome_read')
    const value = await tool?.execute({ tabId: '7' }, {} as never)
    const view = tool?.presentResult?.({ tabId: '7' }, outcome(value))

    expect(view?.title).toBe('示例页面')
    expect(body(view)).toContain('https://example.test/page')
    expect(body(view)).toContain('4 字符')
    expect(body(view)).toContain('正文内容')
  })

  it('marks a read the configured budget cut short', async () => {
    const backend = fakeBackend({
      read: async () => ({ title: 'T', url: 'https://e.test/', text: 'a'.repeat(500), html: '' }),
    })
    const tool = definitions(backend, { readTextLimit: 100 }).get('chrome_read')
    const value = await tool?.execute({ tabId: '1' }, {} as never)
    expect(body(tool?.presentResult?.({ tabId: '1' }, outcome(value)))).toContain('已截断')
  })

  it('names the screenshot file and its size, and repeats the path for the reader', () => {
    const view = definitions().get('chrome_screenshot')?.presentResult?.(
      SAMPLE_ARGS.chrome_screenshot,
      outcome({ tabId: '3', path: '/tmp/dsh-chrome-shots/1-3.png', bytes: 204_800 }),
    )
    expect(view?.title).toBe('截图 1-3.png · 200 KB')
    expect(body(view)).toBe('/tmp/dsh-chrome-shots/1-3.png')
  })

  it('reports how many elements a click reached', () => {
    const view = definitions().get('chrome_click')?.presentResult?.(
      SAMPLE_ARGS.chrome_click,
      outcome({ tabId: '1', selector: 'a.next', clicked: 3 }),
    )
    expect(view?.title).toBe('已点击 3 个元素')
    expect(body(view)).toBe('a.next')
  })

  it('shows the click count against the match count when they differ', () => {
    const view = definitions().get('chrome_click')?.presentResult?.(
      SAMPLE_ARGS.chrome_click,
      outcome({ tabId: '1', selector: 'a.next', clicked: 1, matched: 5 }),
    )
    expect(view?.title).toBe('已点击 1/5 个元素')
  })

  it('carries the click warnings into the card', () => {
    const view = definitions().get('chrome_click')?.presentResult?.(
      SAMPLE_ARGS.chrome_click,
      outcome({ tabId: '1', selector: '#go', clicked: 1, matched: 1, warnings: ['1 clicked element(s) are covered by another element at their centre; a real click would have landed on the covering element'] }),
    )
    expect(body(view)).toContain('#go')
    expect(body(view)).toContain('⚠')
    expect(body(view)).toContain('covered by another element')
  })

  it('reports a type call without repeating the typed text', () => {
    const view = definitions().get('chrome_type')?.presentResult?.(
      SAMPLE_ARGS.chrome_type,
      outcome({ tabId: '1', selector: '#pw', text: 'hunter2', cleared: true }),
    )
    expect(view?.title).toBe('已输入到 #pw')
    expect(body(view)).toContain('已先清空原内容')
    expect(serialized(view)).not.toContain('hunter2')
  })

  it('passes an evaluated value through as the card body', () => {
    const view = definitions().get('chrome_eval')?.presentResult?.(
      SAMPLE_ARGS.chrome_eval,
      outcome({ tabId: '1', value: '42' }),
    )
    expect(view?.title).toBe('求值结果')
    expect(body(view)).toBe('42')
  })

  it('reports an opened tab by its id', async () => {
    const tool = definitions().get('chrome_open')
    const value = await tool?.execute({ url: 'https://example.test/new' }, {} as never)
    const view = tool?.presentResult?.({ url: 'https://example.test/new' }, outcome(value))
    expect(view?.title).toBe('已打开标签页 9')
    expect(body(view)).toContain('https://example.test/new')
  })

  it('leaves a failed call to the raw error renderer', () => {
    const failure: ToolResult = { isError: true, content: [{ type: 'text', text: 'no Chrome tab available' }] }
    for (const name of TOOL_NAMES) {
      expect(definitions().get(name)?.presentResult?.(SAMPLE_ARGS[name], failure)).toBeUndefined()
    }
  })

  it('leaves a result it cannot parse to the raw renderer', () => {
    const foreign: ToolResult = { isError: false, content: [{ type: 'text', text: 'not json' }] }
    expect(definitions().get('chrome_tabs')?.presentResult?.({}, foreign)).toBeUndefined()
  })
})

describe('tabLabel', () => {
  it('names the implicit targets instead of printing an empty id', () => {
    expect(tabLabel(undefined)).toBe('当前标签页')
    expect(tabLabel('')).toBe('当前标签页')
    expect(tabLabel(null)).toBe('当前标签页')
    expect(tabLabel('active')).toBe('活动标签页')
    expect(tabLabel('17')).toBe('17')
  })
})

describe('chrome_screenshot output path', () => {
  /** The tool over a backend that answers one image, written where a copy can find it. */
  function shotTool(mime: string): ToolDefinition {
    const tab: BackendTab = { id: '7', title: 'T', url: 'https://e.test/', active: true, favicon: '' }
    const source = join(mkdtempSync(join(tmpdir(), 'dsh-upload-')), 'upload.jpg')
    writeFileSync(source, Buffer.from([0xff, 0xd8, 0xff]))
    const backend = {
      lastEvalWorld: undefined,
      ensure: async () => {},
      activeTabId: async () => tab.id,
      listTabs: async () => [tab],
      openTab: async () => tab,
    closeTab: async () => {},
      read: async () => ({ title: '', url: '', text: '', html: '' }),
      inventory: async () => ({ title: '', url: '', matched: 0, items: [] }),
      navigate: async () => {},
      waitForLoad: async () => {},
      evaluate: async () => undefined,
      click: async () => EMPTY_CLICK,
      hover: async () => ({ matched: 0, hovered: false }),
      press: async () => ({ found: false, pressed: false, submitted: false }),
      select: async () => ({ matched: 0, changed: false, value: '', options: [] }),
      waitFor: async () => false,
      type: async () => {},
      screenshot: async () => ({ data: '', path: source, mime }),
      startConsole: async () => {},
      stopConsole: async () => {},
      dispose: () => {},
    } as unknown as BrowserBackend
    const found = chromeToolDefinitions(
      backend, resolveChromeConfig({}), new ConsoleLog(), new HelpChannel(),
    ).find(definition => definition.name === 'chrome_screenshot')
    if (found === undefined) throw new Error('chrome_screenshot is not registered')
    return found
  }

  it('corrects a .png request when the bridge produced a JPEG', async () => {
    // A JPEG named `.png` is rejected by readers that trust the extension.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-shot-'))
    const value = await shotTool('image/jpeg').execute(
      { tabId: '7', path: join(dir, 'shot.png') }, {} as never,
    ) as { path: string; mime: string }
    expect(value.path).toBe(join(dir, 'shot.jpg'))
    expect(value.mime).toBe('image/jpeg')
  })

  it('leaves a matching extension alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-shot-'))
    const value = await shotTool('image/png').execute(
      { tabId: '7', path: join(dir, 'shot.png') }, {} as never,
    ) as { path: string; mime: string }
    expect(value.path).toBe(join(dir, 'shot.png'))
    expect(value.mime).toBe('image/png')
  })

  it('leaves an unrecognised name alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-shot-'))
    const value = await shotTool('image/jpeg').execute(
      { tabId: '7', path: join(dir, 'capture') }, {} as never,
    ) as { path: string }
    expect(value.path).toBe(join(dir, 'capture'))
  })
})
