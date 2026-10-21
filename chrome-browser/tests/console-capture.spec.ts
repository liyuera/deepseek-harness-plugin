/**
 * Console capture: how a DevTools event becomes a message, whether the two
 * copies of that mapping agree, and the lifecycle of the `chrome_console` tool.
 */
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { BackendTab, BrowserBackend, ClickOutcome } from '../src/backend.ts'
import { resolveChromeConfig } from '../src/chrome.ts'
import { ConsoleLog } from '../src/console-log.ts'
import { HelpChannel } from '../src/help.ts'
import { consoleMessageFrom } from '../src/console-events.ts'
import type { CapturedMessage } from '../src/console-events.ts'
import { chromeToolDefinitions } from '../src/tools.ts'
import { loadExtensionFunction } from './support/extension-source.ts'

/** `consoleMessageFrom` as the shipped extension implements it. */
const extensionConsoleMessageFrom = loadExtensionFunction<
  (method: string, params: Record<string, unknown>) => CapturedMessage | undefined
>(
  ['MAX_ARG_CHARS', 'renderRemote', 'sourceFromStack', 'sourceFromEntry', 'consoleMessageFrom'],
  'consoleMessageFrom',
)()

/** Recorded DevTools events, as Chrome sends them. */
const EVENTS: Array<[string, Record<string, unknown>]> = [
  ['Runtime.consoleAPICalled', {
    type: 'log',
    args: [{ type: 'string', value: 'hello' }, { type: 'number', value: 42 }],
    stackTrace: { callFrames: [{ url: 'https://e.test/app.js', lineNumber: 6 }] },
  }],
  ['Runtime.consoleAPICalled', {
    type: 'error',
    args: [{ type: 'object', description: 'Error: boom', preview: { description: 'Error', properties: [{ name: 'message', type: 'string', value: 'boom' }] } }],
  }],
  ['Runtime.consoleAPICalled', { type: 'debug', args: [{ type: 'undefined' }] }],
  ['Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'object', subtype: 'null', value: null }] }],
  ['Runtime.consoleAPICalled', {
    type: 'log',
    args: [{ type: 'object', description: 'Object', preview: { properties: [{ name: 'a', type: 'number', value: 1 }, { name: 'b', type: 'string', value: 'x' }], overflow: true } }],
  }],
  ['Runtime.consoleAPICalled', { type: 'warning', args: [] }],
  ['Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'function', description: 'function go() {}' }] }],
  ['Log.entryAdded', { entry: { level: 'error', text: 'Failed to load resource', url: 'http://127.0.0.1:1/nope', lineNumber: 0 } }],
  ['Log.entryAdded', { entry: { level: 'verbose', text: 'deprecated thing' } }],
  ['Log.entryAdded', { entry: { level: 'error', text: '' } }],
  ['Log.entryAdded', { entry: 'not an object' }],
  ['Runtime.consoleAPICalled', { type: 'log' }],
  ['Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'x'.repeat(10_000) }] }],
  ['Runtime.executionContextCreated', { context: {} }],
]

describe('consoleMessageFrom', () => {
  it('renders a console call with its arguments and call site', () => {
    expect(consoleMessageFrom('Runtime.consoleAPICalled', EVENTS[0]![1])).toEqual({
      level: 'log',
      text: 'hello 42',
      source: 'https://e.test/app.js:7',
    })
  })

  it('keeps the level the page used', () => {
    expect(consoleMessageFrom('Runtime.consoleAPICalled', { type: 'error', args: [] })?.level).toBe('error')
    expect(consoleMessageFrom('Runtime.consoleAPICalled', { type: 'warning', args: [] })?.level).toBe('warning')
  })

  it('renders an error object from its preview', () => {
    expect(consoleMessageFrom('Runtime.consoleAPICalled', EVENTS[1]![1])?.text).toBe('Error{message: boom}')
  })

  it('renders undefined, null and plain objects as the console does', () => {
    expect(consoleMessageFrom('Runtime.consoleAPICalled', EVENTS[2]![1])?.text).toBe('undefined')
    expect(consoleMessageFrom('Runtime.consoleAPICalled', EVENTS[3]![1])?.text).toBe('null')
    expect(consoleMessageFrom('Runtime.consoleAPICalled', EVENTS[4]![1])?.text).toBe('{a: 1, b: x, …}')
  })

  it('falls back to a description when there is no preview', () => {
    expect(consoleMessageFrom('Runtime.consoleAPICalled', EVENTS[6]![1])?.text).toBe('function go() {}')
  })

  it('omits the call site when the stack has none', () => {
    expect(consoleMessageFrom('Runtime.consoleAPICalled', { type: 'log', args: [] })).toEqual({ level: 'log', text: '' })
  })

  it('keeps a browser-raised entry, which no console wrapper would ever see', () => {
    expect(consoleMessageFrom('Log.entryAdded', EVENTS[7]![1])).toEqual({
      level: 'error',
      text: 'Failed to load resource',
      source: 'http://127.0.0.1:1/nope:0',
    })
  })

  it('keeps a browser entry that carries no url', () => {
    expect(consoleMessageFrom('Log.entryAdded', EVENTS[8]![1])).toEqual({ level: 'verbose', text: 'deprecated thing' })
  })

  it('drops an empty entry and anything that is not a console event', () => {
    expect(consoleMessageFrom('Log.entryAdded', EVENTS[9]![1])).toBeUndefined()
    expect(consoleMessageFrom('Log.entryAdded', EVENTS[10]![1])).toBeUndefined()
    expect(consoleMessageFrom('Runtime.executionContextCreated', {})).toBeUndefined()
  })

  it('caps one argument list so a huge log cannot bloat an entry', () => {
    const text = consoleMessageFrom('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'x'.repeat(10_000) }],
    })?.text ?? ''
    expect(text.length).toBe(2048)
  })
})

describe('the host and the extension agree on every event', () => {
  it('produces identical messages', () => {
    for (const [method, params] of EVENTS) {
      expect(extensionConsoleMessageFrom(method, params), `${method} ${JSON.stringify(params).slice(0, 60)}`)
        .toEqual(consoleMessageFrom(method, params))
    }
  })
})

/** A host whose backend only records capture calls; the buffer is real. */
function host(): {
  readonly calls: string[]
  readonly log: ConsoleLog
  readonly tools: Map<string, ToolDefinition>
} {
  const calls: string[] = []
  const log = new ConsoleLog()
  const tab: BackendTab = { id: '7', title: 'T', url: 'https://e.test/', active: true, favicon: '' }
  const empty: ClickOutcome = {
    matched: 0, clicked: 0, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0,
  }
  const backend: BrowserBackend = {
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
    webmcpTools: async () => ({ available: false, reason: 'test backend', tools: [] }),
    webmcpCall: async () => { throw new Error('no WebMCP tool in the test backend') },

    click: async () => empty,
    hover: async () => ({ matched: 0, hovered: false }),
    press: async () => ({ found: true, pressed: true, submitted: false }),
    select: async () => ({ matched: 1, changed: true, value: 'x', options: ['x'] }),
    waitFor: async () => false,
    type: async () => {},
    screenshot: async () => ({ data: '' }),
    startConsole: async (tabId: string) => { calls.push(`start:${tabId}`) },
    stopConsole: async (tabId: string) => { calls.push(`stop:${tabId}`) },
    dispose: () => {},
  }
  const tools = new Map(
    chromeToolDefinitions(backend, resolveChromeConfig({}), log, new HelpChannel())
      .map(definition => [definition.name, definition]),
  )
  return { calls, log, tools }
}

/** Run `chrome_console` with one argument set. */
async function consoleTool(
  fixture: ReturnType<typeof host>,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = fixture.tools.get('chrome_console')
  if (tool === undefined) throw new Error('chrome_console is not registered')
  return await tool.execute(args as never, {} as never) as unknown as Record<string, unknown>
}

describe('chrome_console lifecycle', () => {
  it('refuses to read a tab that is not capturing', async () => {
    const fixture = host()
    await expect(consoleTool(fixture, { action: 'read', tabId: '7' })).rejects.toThrow(/not being captured/)
    expect(fixture.calls).toEqual([])
  })

  it('starts capture on the backend and opens the buffer', async () => {
    const fixture = host()
    const started = await consoleTool(fixture, { action: 'start', tabId: '7' })
    expect(fixture.calls).toEqual(['start:7'])
    expect(started).toEqual({ tabId: '7', capturing: true, capturingTabs: ['7'] })
  })

  it('starts capture idempotently', async () => {
    const fixture = host()
    await consoleTool(fixture, { action: 'start', tabId: '7' })
    await consoleTool(fixture, { action: 'start', tabId: '7' })
    expect(fixture.calls).toEqual(['start:7', 'start:7'])
    expect(fixture.log.tracked()).toEqual(['7'])
  })

  it('reads what the capture sink appended, with a cursor to continue from', async () => {
    const fixture = host()
    await consoleTool(fixture, { action: 'start', tabId: '7' })
    fixture.log.append('7', { level: 'log', text: 'first' })
    fixture.log.append('7', { level: 'error', text: 'second', source: 'https://e.test/a.js:3' })

    const page = await consoleTool(fixture, { action: 'read', tabId: '7' })
    expect(page.entries).toEqual([
      { seq: 1, at: expect.any(Number), level: 'log', text: 'first' },
      { seq: 2, at: expect.any(Number), level: 'error', text: 'second', source: 'https://e.test/a.js:3' },
    ])
    expect(page).toMatchObject({ tabId: '7', retained: 2, dropped: 0, cursor: 2 })

    // The cursor continues without repeating.
    fixture.log.append('7', { level: 'log', text: 'third' })
    const next = await consoleTool(fixture, { action: 'read', tabId: '7', since: page.cursor })
    expect((next.entries as Array<{ text: string }>).map(entry => entry.text)).toEqual(['third'])
    expect(next.cursor).toBe(3)
  })

  it('reports what the bounded buffer evicted', async () => {
    const fixture = host()
    await consoleTool(fixture, { action: 'start', tabId: '7' })
    for (let index = 0; index < 210; index += 1) fixture.log.append('7', { level: 'log', text: `line ${index}` })
    const page = await consoleTool(fixture, { action: 'read', tabId: '7' })
    expect(page.retained).toBe(200)
    expect(page.dropped).toBe(10)
  })

  it('stops capture on the backend and drops the buffer', async () => {
    const fixture = host()
    await consoleTool(fixture, { action: 'start', tabId: '7' })
    fixture.log.append('7', { level: 'log', text: 'gone' })
    const stopped = await consoleTool(fixture, { action: 'stop', tabId: '7' })
    expect(fixture.calls).toEqual(['start:7', 'stop:7'])
    expect(stopped).toEqual({ tabId: '7', capturing: false })
    expect(fixture.log.tracked()).toEqual([])
    await expect(consoleTool(fixture, { action: 'read', tabId: '7' })).rejects.toThrow(/not being captured/)
  })

  it('resolves the tab the way every other tool does when tabId is omitted', async () => {
    const fixture = host()
    const started = await consoleTool(fixture, { action: 'start' })
    expect(started.tabId).toBe('7')
    expect(fixture.calls).toEqual(['start:7'])
  })
})
