/**
 * WebMCP: tools a page declares through `document.modelContext`, surfaced as
 * `chrome_webmcp_list` / `chrome_webmcp_call`.
 *
 * One `__dshWebmcp` envelope crosses three layers, and each layer is tested
 * where it actually runs:
 * - the envelope is produced twice — by the CDP expressions in
 *   `src/expressions.ts` and by the extension's MAIN-world helpers, because the
 *   bridge cannot import host modules — and one mapper pair reads it for both
 *   backends;
 * - `chrome.scripting.executeScript` serializes a helper's returned promise
 *   instead of awaiting it, so the extension stores the request state on
 *   `window.__dshWebmcp` and polls it for 8s. A declarative form that never
 *   settles is reported as `pending`, never as success: saying "done" and
 *   telling a retry to run it again would submit the form twice;
 * - `webmcp-list` is retry-safe, `webmcp-call` has side effects, so a bridge
 *   disconnect must refuse the call instead of replaying it.
 */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {
  BackendInventory,
  BackendRead,
  BrowserBackend,
  ClickOutcome,
  WebMcpCallOutcome,
  WebMcpTool,
  WebMcpTools,
} from '../src/backend.ts'
import {
  CdpBackend,
  ExtensionBackend,
  mapWebMcpCall,
  mapWebMcpTools,
} from '../src/backend.ts'
import { resolveChromeConfig } from '../src/chrome.ts'
import { ConsoleLog } from '../src/console-log.ts'
import { HelpChannel } from '../src/help.ts'
import { chromeToolDefinitions } from '../src/tools.ts'
import { loadExtensionFunction } from './support/extension-source.ts'

/** The shape either page-side copy stores; only the fields under test are named. */
interface WebMcpEnvelope {
  __dshWebmcp?: unknown
  done?: boolean
  available?: boolean
  reason?: string
  ok?: boolean
  error?: string
  tool?: string
  tools?: unknown[]
  result?: unknown
  pending?: boolean
  note?: string
  navigated?: boolean
}

/** One tool as a page declares it: no origin, so each page-side copy fills it in. */
const PAGE_SEARCH_TOOL = {
  name: 'search',
  title: 'Search',
  description: 'Find things',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  annotations: { readOnlyHint: true },
}

/** The same tool after the origin fallback — what both mappers report. */
const SEARCH_TOOL: WebMcpTool = { ...PAGE_SEARCH_TOOL, origin: 'https://example.test' }

/** One click that matched nothing; a fake backend only needs the type. */
const EMPTY_CLICK: ClickOutcome = {
  matched: 0, clicked: 0, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0,
}

/** A backend that answers with fixed values; tests override the operation they exercise. */
function fakeBackend(overrides: Partial<BrowserBackend> = {}): BrowserBackend {
  return {
    lastEvalWorld: undefined,
    ensure: async () => {},
    activeTabId: async () => '1',
    listTabs: async () => [],
    openTab: async (url: string) => ({ id: '9', title: '', url, active: true, favicon: '' }),
    closeTab: async () => {},
    read: async (): Promise<BackendRead> => ({ title: '', url: '', text: '', html: '' }),
    inventory: async (): Promise<BackendInventory> => ({ title: '', url: '', matched: 0, items: [] }),
    navigate: async () => {},
    waitForLoad: async () => {},
    evaluate: async () => undefined,
    webmcpTools: async (): Promise<WebMcpTools> => ({ available: false, reason: 'test backend', tools: [] }),
    webmcpCall: async () => { throw new Error('no WebMCP tool in the test backend') },
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

/** The plugin's definitions over one backend. */
function tools(backend: BrowserBackend): Map<string, ToolDefinition> {
  return new Map(
    chromeToolDefinitions(backend, resolveChromeConfig({}), new ConsoleLog(), new HelpChannel())
      .map(definition => [definition.name, definition]),
  )
}

/** One definition, or a failure that names what is missing. */
function toolFor(backend: BrowserBackend, name: string): ToolDefinition {
  const found = tools(backend).get(name)
  if (found === undefined) throw new Error(`${name} is not registered`)
  return found
}

/** Let the injected page helper's promise chain settle: its steps are microtasks. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** Let a queued bridge command reach the fake socket. */
const tick = (ms = 10): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('mapWebMcpTools', () => {
  it('reads a missing WebMCP surface as an answer, keeping the page reason', () => {
    // "No surface" is not an error: the model falls back to the DOM tools, and
    // the reason is what tells it whether a browser flag or the page is missing.
    expect(mapWebMcpTools({ __dshWebmcp: 1, available: false, reason: 'Chrome 未启用 WebMCP' }))
      .toEqual({ available: false, reason: 'Chrome 未启用 WebMCP', tools: [] })
  })

  it('defaults the reason when the page reports none', () => {
    expect(mapWebMcpTools({ __dshWebmcp: 1, available: false }))
      .toEqual({ available: false, reason: '该页面没有可用的 WebMCP 工具', tools: [] })
  })

  it('normalizes declared tools and drops rows without a usable name', () => {
    // A nameless row cannot be called, so listing it would offer the model a
    // tool it can never invoke.
    const listing = mapWebMcpTools({
      __dshWebmcp: 1,
      available: true,
      tools: [
        { ...PAGE_SEARCH_TOOL, origin: 'https://example.test' },
        { name: 'minimal' },
        { title: 'nameless' },
        'not a tool',
        null,
      ],
    })
    expect(listing).toEqual({
      available: true,
      tools: [
        SEARCH_TOOL,
        { name: 'minimal', title: '', description: '', origin: '', inputSchema: null, annotations: {} },
      ],
    })
  })

  it('keeps available true with no tools: the API exists, the page registers nothing', () => {
    // Real Chrome with the WebMCP flag on answers exactly this way for a page
    // that implements no tools. `available` is about the API surface, not the
    // count — conflating the two would send the model looking for a flag that
    // is already on.
    expect(mapWebMcpTools({ __dshWebmcp: 1, available: true, tools: [] }))
      .toEqual({ available: true, tools: [] })
    expect(mapWebMcpTools({ __dshWebmcp: 1, available: true }))
      .toEqual({ available: true, tools: [] })
  })

  it('refuses anything that is not a WebMCP listing envelope', () => {
    // The tag keeps a page's own `{ available, tools }` JSON from being taken
    // for this protocol's answer.
    for (const value of [
      null,
      'tools',
      [],
      { available: true, tools: [] },
      { __dshWebmcp: 2, available: true },
    ]) {
      expect(() => mapWebMcpTools(value)).toThrow('WebMCP 列表应答格式无法识别')
    }
  })
})

describe('mapWebMcpCall', () => {
  it('throws the page error so the model can pick another tool', () => {
    expect(() => mapWebMcpCall({
      __dshWebmcp: 1,
      ok: false,
      error: '当前页面没有名为 "nope" 的 WebMCP 工具;可用: search, checkout',
    })).toThrow('当前页面没有名为 "nope" 的 WebMCP 工具;可用: search, checkout')
  })

  it('falls back to a generic failure when the page reports no reason', () => {
    expect(() => mapWebMcpCall({ __dshWebmcp: 1, ok: false })).toThrow('WebMCP 工具调用失败')
  })

  it('keeps a pending activation and its note apart from a success', () => {
    // The distinction is the point: success means the value is final, pending
    // means a human still has to act and a retry would act twice.
    expect(mapWebMcpCall({ __dshWebmcp: 1, ok: true, tool: 'form', pending: true, note: '请在页面上点击提交' }))
      .toEqual({ tool: 'form', pending: true, note: '请在页面上点击提交' })
  })

  it('omits an empty note instead of rendering a blank line', () => {
    expect(mapWebMcpCall({ __dshWebmcp: 1, ok: true, tool: 'form', pending: true, note: '' }))
      .toEqual({ tool: 'form', pending: true })
  })

  it('reports a navigation instead of an absent result', () => {
    // A tool that reloads the page resolves to null: there is no value to read,
    // and the caller must not treat that as an empty result.
    expect(mapWebMcpCall({ __dshWebmcp: 1, ok: true, tool: 'checkout', navigated: true }))
      .toEqual({ tool: 'checkout', navigated: true })
  })

  it('passes the tool result through unchanged', () => {
    const result = { hits: 2, items: [{ id: 1 }] }
    expect(mapWebMcpCall({ __dshWebmcp: 1, ok: true, tool: 'search', result }))
      .toEqual({ tool: 'search', result })
  })

  it('refuses anything that is not a WebMCP call envelope', () => {
    for (const value of [null, 'ok', [], { ok: true, tool: 'x' }, { __dshWebmcp: 2, ok: true }]) {
      expect(() => mapWebMcpCall(value)).toThrow('WebMCP 调用应答格式无法识别')
    }
  })
})

/** The extension's injected helpers, loaded against one stub page. */
function extensionPage(
  document: unknown,
  location: Record<string, unknown> = { origin: 'https://example.test' },
): {
  /** The stub page's global object, where the helpers store their state. */
  page: Record<string, unknown>
  begin: (request: Record<string, unknown>) => boolean
  poll: () => WebMcpEnvelope | null
} {
  const page: Record<string, unknown> = {}
  const load = (name: string): unknown => loadExtensionFunction<unknown>(
    [name], name, ['document', 'window', 'location'],
  )(document, page, location)
  return {
    page,
    begin: load('webmcpBegin') as (request: Record<string, unknown>) => boolean,
    poll: load('webmcpPoll') as () => WebMcpEnvelope | null,
  }
}

describe('the extension page helpers', () => {
  it('answers a missing modelContext instead of waiting for one', async () => {
    const helper = extensionPage({})
    expect(helper.poll(), 'nothing is stored before a request').toBeNull()

    expect(helper.begin({ mode: 'list' })).toBe(true)
    await settle()
    const listing = helper.poll()
    expect(listing).toMatchObject({ __dshWebmcp: 1, done: true, available: false })
    expect(String(listing?.reason)).toContain('document.modelContext')

    helper.begin({ mode: 'call', name: 'search', input: {} })
    await settle()
    const call = helper.poll()
    expect(call).toMatchObject({ __dshWebmcp: 1, done: true, ok: false })
    expect(String(call?.error)).toContain('document.modelContext')
  })

  it('stores a listing on window.__dshWebmcp, filling what the page omitted', async () => {
    // The state lives on the page because `executeScript` cannot await the
    // helper's promise; the service worker polls that global afterwards.
    const helper = extensionPage({
      modelContext: { getTools: async () => [PAGE_SEARCH_TOOL, { name: 'minimal' }] },
    })
    helper.begin({ mode: 'list' })
    await settle()
    expect(helper.page.__dshWebmcp, 'the state lives on the page global').toBe(helper.poll())
    expect(helper.poll()).toEqual({
      done: true,
      __dshWebmcp: 1,
      available: true,
      tools: [
        SEARCH_TOOL,
        { name: 'minimal', title: '', description: '', origin: 'https://example.test', inputSchema: null, annotations: {} },
      ],
    })
  })

  it('reports a rejected getTools as unavailable with the page reason', async () => {
    const helper = extensionPage({
      modelContext: { getTools: async () => { throw new Error('origin trial expired') } },
    })
    helper.begin({ mode: 'list' })
    await settle()
    expect(helper.poll()).toMatchObject({ done: true, available: false, reason: 'origin trial expired' })
  })

  it('lists the declared names when the requested tool is not there', async () => {
    // The model picks the next tool from this message, so it must name the real
    // candidates rather than just say "unknown tool".
    const helper = extensionPage({
      modelContext: {
        getTools: async () => [{ name: 'alpha' }, { name: 'beta' }],
        executeTool: async () => { throw new Error('the page tool must not run') },
      },
    })
    helper.begin({ mode: 'call', name: 'gamma', input: {} })
    await settle()
    const state = helper.poll()
    expect(state).toMatchObject({ __dshWebmcp: 1, done: true, ok: false })
    expect(String(state?.error)).toContain('"gamma"')
    expect(String(state?.error)).toContain('可用: alpha, beta')
  })

  it('says the page registers nothing when the tool list is empty', async () => {
    const helper = extensionPage({
      modelContext: { getTools: async () => [], executeTool: async () => null },
    })
    helper.begin({ mode: 'call', name: 'gamma', input: {} })
    await settle()
    expect(helper.poll()?.error).toBe('当前页面没有注册任何 WebMCP 工具')
  })

  it('executes the named tool with the whole input and stores its result', async () => {
    const received: { tool?: { name?: string }; input?: unknown } = {}
    const helper = extensionPage({
      modelContext: {
        getTools: async () => [{ name: 'search' }, { name: 'other' }],
        executeTool: async (tool: { name?: string }, input: unknown) => {
          received.tool = tool
          received.input = input
          return { hits: 2 }
        },
      },
    })
    helper.begin({ mode: 'call', name: 'search', input: { q: '手机' } })
    await settle()
    expect(received.tool?.name).toBe('search')
    expect(received.input).toEqual({ q: '手机' })
    expect(helper.poll()).toEqual({
      done: true,
      __dshWebmcp: 1,
      ok: true,
      tool: 'search',
      result: { hits: 2 },
    })

    helper.begin({ mode: 'call', name: 'search' })
    await settle()
    expect(received.input, 'an omitted input reaches the page as one empty object').toEqual({})
  })

  it('reads a null tool result as a navigation, because a reload discards it', async () => {
    const helper = extensionPage({
      modelContext: { getTools: async () => [{ name: 'go' }], executeTool: async () => null },
    })
    helper.begin({ mode: 'call', name: 'go', input: {} })
    await settle()
    expect(helper.poll()).toEqual({ done: true, __dshWebmcp: 1, ok: true, tool: 'go', navigated: true })
  })

  it('leaves the state unfinished while the page tool has not settled', async () => {
    // A declarative form tool waits for the user. Marking the state done here
    // would report a submit that has not happened.
    const helper = extensionPage({
      modelContext: { getTools: async () => [{ name: 'form' }], executeTool: () => new Promise(() => {}) },
    })
    helper.begin({ mode: 'call', name: 'form', input: {} })
    await settle()
    expect(helper.poll()).toEqual({ done: false })
  })

  it('stores a thrown tool failure instead of letting it escape the page', async () => {
    // An escaping throw reaches the host as `result: undefined` — the same
    // answer as an empty page — so the failure must be part of the state.
    const helper = extensionPage({
      modelContext: {
        getTools: async () => [{ name: 'boom' }],
        executeTool: async () => { throw new Error('用户拒绝') },
      },
    })
    helper.begin({ mode: 'call', name: 'boom', input: {} })
    await settle()
    expect(helper.poll()).toMatchObject({ done: true, ok: false, error: '用户拒绝' })
  })

  it('answers a broken page synchronously instead of letting its throw escape', () => {
    // A throw escaping the injected function reaches the host as
    // `result: undefined` — the same answer as "nothing happened" — so the
    // helper must turn it into its own envelope before returning. Both cases
    // land in the state without waiting for a promise.
    const noGetTools = extensionPage({ modelContext: { executeTool: async () => 'done' } })
    expect(noGetTools.begin({ mode: 'call', name: 'search', input: {} })).toBe(true)
    expect(noGetTools.poll()).toMatchObject({ done: true, __dshWebmcp: 1, ok: false })
    expect(String(noGetTools.poll()?.error)).toContain('document.modelContext')

    // A getTools that throws synchronously (not just a rejected promise).
    const throwing = extensionPage({ modelContext: { getTools: () => { throw new Error('mock boom') } } })
    expect(throwing.begin({ mode: 'list' })).toBe(true)
    expect(throwing.poll()).toEqual({ done: true, __dshWebmcp: 1, available: false, reason: 'mock boom' })
  })
})

/** One command the bridge wrote to its socket. */
interface BridgeCommand {
  seq: number
  op: string
  args: Record<string, unknown>
}

/** A fake upgraded socket: captures written bytes and feeds responses back. */
class FakeSocket extends EventEmitter {
  written: Buffer[] = []

  write(chunk: Buffer | string): boolean {
    this.written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return true
  }

  end(): this {
    return this
  }

  destroy(): this {
    return this
  }

  /** Feed raw bytes (e.g. a masked client frame) to the connection parser. */
  feed(chunk: Buffer): void {
    this.emit('data', chunk)
  }

  /** Encode one masked client text frame (per RFC 6455). */
  static clientText(text: string): Buffer {
    const payload = Buffer.from(text, 'utf8')
    const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
    const masked = Buffer.allocUnsafe(payload.length)
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i & 3]!
    let header: Buffer
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length])
    } else {
      header = Buffer.alloc(4)
      header[0] = 0x81
      header[1] = 0x80 | 126
      header.writeUInt16BE(payload.length, 2)
    }
    return Buffer.concat([header, mask, masked])
  }

  /** The last server frame's text payload (unmasked, text opcode). */
  lastServerText(): string | undefined {
    for (let i = this.written.length - 1; i >= 0; i--) {
      const frame = this.written[i]!
      if ((frame[0]! & 0x0f) !== 0x1) continue
      // Server frames are unmasked, and a WebMCP command can exceed the 125-byte
      // short form: the length then sits in an extended header field.
      const length = frame[1]! & 0x7f
      if (length < 126) return frame.subarray(2, 2 + length).toString('utf8')
      if (length === 126) return frame.subarray(4, 4 + frame.readUInt16BE(2)).toString('utf8')
      return frame.subarray(10, 10 + Number(frame.readBigUInt64BE(2))).toString('utf8')
    }
    return undefined
  }
}

/** A bridge backend attached to one fake socket. */
function makeBridge(timeoutMs = 5000): { backend: ExtensionBackend; socket: FakeSocket } {
  const backend = new ExtensionBackend(resolveChromeConfig({ timeoutMs }))
  const socket = new FakeSocket()
  backend.attach(socket as never, Buffer.alloc(0))
  return { backend, socket }
}

/** Feed the extension's self-introduction. The build stamp matches, so no reload is asked for. */
function advertise(backend: ExtensionBackend, socket: FakeSocket, ops: string[]): void {
  socket.feed(FakeSocket.clientText(JSON.stringify({
    kind: 'hello',
    version: 'test',
    ops,
    build: backend.extensionStatus().expectedBuild,
  })))
}

/** The most recent command frame the backend wrote. */
function sentCommand(socket: FakeSocket): BridgeCommand {
  const frame = JSON.parse(socket.lastServerText() ?? '{}') as { kind?: string; commands?: BridgeCommand[] }
  expect(frame.kind).toBe('commands')
  const command = frame.commands?.[0]
  if (command === undefined) throw new Error('no command frame was written to the bridge')
  return command
}

/** Answer one command with a successful result payload. */
function answerCommand(socket: FakeSocket, command: BridgeCommand, data: unknown): void {
  socket.feed(FakeSocket.clientText(JSON.stringify({
    kind: 'results',
    results: [{ seq: command.seq, ok: true, data }],
  })))
}

describe('the bridge backend', () => {
  it('sends webmcp-list with the tab id and maps the reply', async () => {
    const { backend, socket } = makeBridge()
    advertise(backend, socket, ['list-tabs', 'webmcp-list', 'webmcp-call'])
    const listing = backend.webmcpTools('7')
    await tick()
    const frame = JSON.parse(socket.lastServerText()!) as { kind: string; commands: BridgeCommand[] }
    expect(frame.kind).toBe('commands')
    expect(frame.commands).toEqual([{ seq: expect.any(Number), op: 'webmcp-list', args: { tabId: '7' } }])
    answerCommand(socket, frame.commands[0]!, { __dshWebmcp: 1, available: true, tools: [SEARCH_TOOL] })
    await expect(listing).resolves.toEqual({ available: true, tools: [SEARCH_TOOL] })
  })

  it('sends the tool name and its whole input object in one webmcp-call command', async () => {
    const { backend, socket } = makeBridge()
    advertise(backend, socket, ['list-tabs', 'webmcp-list', 'webmcp-call'])
    const call = backend.webmcpCall('7', 'search', { q: '手机', limit: 10 })
    await tick()
    const frame = JSON.parse(socket.lastServerText()!) as { kind: string; commands: BridgeCommand[] }
    expect(frame.commands).toEqual([{
      seq: expect.any(Number),
      op: 'webmcp-call',
      args: { tabId: '7', name: 'search', input: { q: '手机', limit: 10 } },
    }])
    answerCommand(socket, frame.commands[0]!, { __dshWebmcp: 1, ok: true, tool: 'search', result: { hits: 2 } })
    await expect(call).resolves.toEqual({ tool: 'search', result: { hits: 2 } })
  })

  it('maps a pending activation and a navigation from the bridge', async () => {
    const { backend, socket } = makeBridge()
    advertise(backend, socket, ['webmcp-call'])

    const pending = backend.webmcpCall('7', 'checkout', {})
    await tick()
    answerCommand(socket, sentCommand(socket), {
      __dshWebmcp: 1, ok: true, tool: 'checkout', pending: true, note: '请点击提交',
    })
    await expect(pending).resolves.toEqual({ tool: 'checkout', pending: true, note: '请点击提交' })

    const navigated = backend.webmcpCall('7', 'go', {})
    await tick()
    answerCommand(socket, sentCommand(socket), { __dshWebmcp: 1, ok: true, tool: 'go', navigated: true })
    await expect(navigated).resolves.toEqual({ tool: 'go', navigated: true })
  })

  it('rejects with the page error rather than a silent empty result', async () => {
    const { backend, socket } = makeBridge()
    advertise(backend, socket, ['webmcp-call'])
    const call = backend.webmcpCall('7', 'nope', {})
    await tick()
    answerCommand(socket, sentCommand(socket), {
      __dshWebmcp: 1, ok: false, error: '当前页面没有名为 "nope" 的 WebMCP 工具;可用: search',
    })
    await expect(call).rejects.toThrow(/可用: search/u)
  })

  it('refuses a reply that is not a WebMCP envelope', async () => {
    const { backend, socket } = makeBridge()
    advertise(backend, socket, ['webmcp-list'])
    const listing = backend.webmcpTools('7')
    await tick()
    answerCommand(socket, sentCommand(socket), { available: true, tools: [] })
    await expect(listing).rejects.toThrow('WebMCP 列表应答格式无法识别')
  })

  it('refuses both ops on an extension that does not advertise them', async () => {
    // Sending anyway earns `unknown op`, which says nothing about an extension
    // whose files are older than the plugin driving it.
    const { backend, socket } = makeBridge()
    advertise(backend, socket, ['list-tabs'])
    await expect(backend.webmcpTools('7')).rejects.toThrow(/扩展不支持 webmcp-list/u)
    await expect(backend.webmcpCall('7', 'search', {})).rejects.toThrow(/扩展不支持 webmcp-call/u)
    await expect(backend.webmcpTools('7')).rejects.toThrow(/chrome:\/\/extensions/u)
    expect(socket.lastServerText(), 'a refused op never reaches the wire').toBeUndefined()
  })

  it('retries webmcp-list after a disconnect, because re-reading is harmless', async () => {
    const { backend, socket } = makeBridge(300)
    advertise(backend, socket, ['webmcp-list'])
    const listing = backend.webmcpTools('7')
    void listing.catch(() => { /* resolved via the reconnect below */ })
    await tick()
    socket.emit('close')
    backend.detach()
    let settled = false
    void listing.finally(() => { settled = true })
    await tick(50)
    expect(settled, 'a safe read is held through the reconnect grace window').toBe(false)

    const socket2 = new FakeSocket()
    backend.attach(socket2 as never, Buffer.alloc(0))
    await tick()
    const resent = sentCommand(socket2)
    expect(resent.op).toBe('webmcp-list')
    answerCommand(socket2, resent, { __dshWebmcp: 1, available: true, tools: [SEARCH_TOOL] })
    await expect(listing).resolves.toEqual({ available: true, tools: [SEARCH_TOOL] })
  })

  it('refuses a webmcp-call whose outcome is unknown instead of replaying it', async () => {
    // The page's tool already ran. Re-sending after a reconnect would run it a
    // second time — a second submit — so the caller gets "unknown outcome".
    const { backend, socket } = makeBridge()
    advertise(backend, socket, ['webmcp-call'])
    const call = backend.webmcpCall('7', 'checkout', { confirm: true })
    await tick()
    expect(sentCommand(socket).op).toBe('webmcp-call')
    socket.emit('close')
    backend.detach()
    await expect(call).rejects.toThrow(/结果未知/u)
    await expect(call).rejects.toThrow(/不要直接重试/u)
  })

  it('joins a concurrent duplicate of one webmcp-call instead of running the tool twice', async () => {
    const { backend, socket } = makeBridge()
    advertise(backend, socket, ['webmcp-call'])
    const first = backend.webmcpCall('7', 'checkout', { confirm: true })
    const second = backend.webmcpCall('7', 'checkout', { confirm: true })
    await tick()
    const frame = JSON.parse(socket.lastServerText()!) as { commands: BridgeCommand[] }
    expect(frame.commands, 'the duplicate must join the in-flight call').toHaveLength(1)
    answerCommand(socket, frame.commands[0]!, { __dshWebmcp: 1, ok: true, tool: 'checkout', result: { ok: true } })
    const expected = { tool: 'checkout', result: { ok: true } }
    await expect(first).resolves.toEqual(expected)
    await expect(second).resolves.toEqual(expected)
  })
})

/** One `Runtime.evaluate` request a fake CDP endpoint received. */
interface EvaluateRequest {
  expression: string
  returnByValue?: unknown
  awaitPromise?: unknown
}

/** A CDP backend whose `Runtime.evaluate` really runs the expression against a stub page. */
function cdpBackend(document: unknown): { backend: CdpBackend; evaluated: EvaluateRequest[] } {
  const evaluated: EvaluateRequest[] = []
  const endpoint = {
    call: async (method: string, params: EvaluateRequest) => {
      expect(method).toBe('Runtime.evaluate')
      evaluated.push(params)
      const run = new Function('document', 'location', `return ${params.expression}`) as
        (document: unknown, location: unknown) => unknown
      return { result: { type: 'object', value: await run(document, { origin: 'https://example.test' }) } }
    },
    close: () => {},
  }
  return { backend: new CdpBackend({ tabEndpoint: async () => ({ endpoint }) } as never), evaluated }
}

describe('the CDP backend', () => {
  it('runs the list expression in the page main world and awaits its answer', async () => {
    const { backend, evaluated } = cdpBackend({
      modelContext: { getTools: async () => [PAGE_SEARCH_TOOL] },
    })
    await expect(backend.webmcpTools('7')).resolves.toEqual({ available: true, tools: [SEARCH_TOOL] })
    expect(evaluated).toHaveLength(1)
    // `modelContext` is page JavaScript: only the MAIN world can see it, and
    // the expression is a promise the protocol must await.
    expect(evaluated[0]?.expression).toContain('document.modelContext')
    expect(evaluated[0]).toMatchObject({ returnByValue: true, awaitPromise: true })
  })

  it('answers a page without modelContext as unavailable, not as an error', async () => {
    const { backend } = cdpBackend({})
    const listing = await backend.webmcpTools('7')
    expect(listing.available).toBe(false)
    expect(listing.reason).toContain('document.modelContext')
  })

  it('runs the named tool with its input and maps the returned value', async () => {
    const runs: Array<{ tool: unknown; input: unknown }> = []
    const { backend, evaluated } = cdpBackend({
      modelContext: {
        getTools: async () => [PAGE_SEARCH_TOOL],
        executeTool: async (tool: unknown, input: unknown) => {
          runs.push({ tool, input })
          return { hits: 2 }
        },
      },
    })
    await expect(backend.webmcpCall('7', 'search', { q: '手机' }))
      .resolves.toEqual({ tool: 'search', result: { hits: 2 } })
    expect(runs).toEqual([{ tool: PAGE_SEARCH_TOOL, input: { q: '手机' } }])
    expect(evaluated[0]?.expression).toContain('"search"')
    expect(evaluated[0]?.expression).toContain('executeTool')
  })

  it('names the declared tools when the named one is not there', async () => {
    const { backend } = cdpBackend({
      modelContext: {
        getTools: async () => [{ name: 'alpha' }, { name: 'beta' }],
        executeTool: async () => { throw new Error('the page tool must not run') },
      },
    })
    await expect(backend.webmcpCall('7', 'gamma', {})).rejects.toThrow(/可用: alpha, beta/u)
  })

  it('reports a tool that never settles as pending after the 8s bound', async () => {
    vi.useFakeTimers()
    try {
      const { backend } = cdpBackend({
        modelContext: {
          getTools: async () => [{ name: 'form' }],
          executeTool: () => new Promise(() => {}),
        },
      })
      const call = backend.webmcpCall('7', 'form', {})
      await vi.advanceTimersByTimeAsync(8000)
      const value = await call
      expect(value).toMatchObject({ tool: 'form', pending: true })
      expect(String(value.note)).toContain('8 秒')
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * Load the extension's poll driver over a `chrome` stub whose injected functions
 * run against one stub page: the globals installed here are what the helpers see.
 * @param document - the stub page's `document`, carrying `modelContext`.
 * @param urls - what `chrome.tabs.get` reports, in call order; the last repeats.
 * @returns `webmcpRequest`, the driver the `webmcp-*` ops delegate to.
 */
function webmcpDriver(
  document: unknown,
  urls: string[] = ['https://example.test/'],
): (tabId: string, request: Record<string, unknown>) => Promise<Record<string, unknown>> {
  let reads = 0
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', {})
  vi.stubGlobal('location', { origin: 'https://example.test' })
  const chrome = {
    tabs: {
      get: async () => ({ url: urls[Math.min(reads++, urls.length - 1)] ?? '' }),
    },
    scripting: {
      executeScript: async (request: { func: (...args: unknown[]) => unknown; args?: unknown[] }) => [
        { result: await request.func(...(request.args ?? [])) },
      ],
    },
  }
  return loadExtensionFunction<(tabId: string, request: Record<string, unknown>) => Promise<Record<string, unknown>>>(
    ['pageExec', 'webmcpBegin', 'webmcpPoll', 'webmcpRequest'], 'webmcpRequest', ['chrome'],
  )(chrome)
}

describe('the extension poll driver', () => {
  // The page helpers run against the page globals; every test drives fake 8s
  // timers, because the deadline is the behavior under test.
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('returns a settled result without waiting for the deadline', async () => {
    vi.useFakeTimers()
    const run = webmcpDriver({
      modelContext: { getTools: async () => [PAGE_SEARCH_TOOL], executeTool: async () => ({ hits: 2 }) },
    })
    const call = run('7', { mode: 'call', name: 'search', input: { q: '手机' } })
    await vi.advanceTimersByTimeAsync(200)
    await expect(call).resolves.toEqual({ __dshWebmcp: 1, ok: true, tool: 'search', result: { hits: 2 } })
  })

  it('reports a never-settling declared form as pending, not as a result', async () => {
    // The user still has to click Submit. Success here would be a lie, and the
    // note is what tells the model to ask instead of calling again.
    vi.useFakeTimers()
    const run = webmcpDriver({
      modelContext: { getTools: async () => [{ name: 'form' }], executeTool: () => new Promise(() => {}) },
    })
    const call = run('7', { mode: 'call', name: 'form', input: {} })
    await vi.advanceTimersByTimeAsync(8000)
    const value = await call
    expect(value).toMatchObject({ __dshWebmcp: 1, ok: true, tool: 'form', pending: true })
    expect(String(value.note)).toContain('8 秒')
    expect(value, 'a pending call has no result to read').not.toHaveProperty('result')
  })

  it('reports a list that never answers as unavailable, naming the timeout', async () => {
    vi.useFakeTimers()
    const run = webmcpDriver({ modelContext: { getTools: () => new Promise(() => {}) } })
    const call = run('7', { mode: 'list' })
    await vi.advanceTimersByTimeAsync(8000)
    await expect(call).resolves.toEqual({
      __dshWebmcp: 1,
      available: false,
      reason: '读取 WebMCP 工具超时(8s)',
    })
  })

  it('reports a list interrupted by a navigation as a list answer, not a call one', async () => {
    // A list is not a tool invocation. Keeping the list envelope and naming the
    // navigation is what lets `mapWebMcpTools` report "could not read the
    // tools"; the call-shaped `{ok, tool:'', navigated}` would be read as
    // "no WebMCP surface" and send the model looking for a browser flag.
    vi.useFakeTimers()
    const run = webmcpDriver(
      { modelContext: { getTools: () => new Promise(() => {}) } },
      ['https://example.test/before', 'https://example.test/after'],
    )
    const call = run('7', { mode: 'list' })
    await vi.advanceTimersByTimeAsync(8000)
    await expect(call).resolves.toEqual({
      __dshWebmcp: 1,
      available: false,
      reason: '读取 WebMCP 工具期间页面发生了导航',
    })
  })

  it('reads a URL change as a navigation when the page destroyed the state', async () => {
    // A reload wipes `window.__dshWebmcp`; the tab's URL is then the only
    // evidence the tool ran and changed the page.
    vi.useFakeTimers()
    const run = webmcpDriver(
      { modelContext: { getTools: async () => [{ name: 'go' }], executeTool: () => new Promise(() => {}) } },
      ['https://example.test/before', 'https://example.test/after'],
    )
    const call = run('7', { mode: 'call', name: 'go', input: {} })
    await vi.advanceTimersByTimeAsync(8000)
    await expect(call).resolves.toEqual({ __dshWebmcp: 1, ok: true, tool: 'go', navigated: true })
  })
})

/** A fake backend that records every WebMCP call it is asked to run. */
function callRecorder(outcome: WebMcpCallOutcome | Error): {
  backend: BrowserBackend
  calls: Array<{ tabId: string; name: string; input: Record<string, unknown> }>
} {
  const calls: Array<{ tabId: string; name: string; input: Record<string, unknown> }> = []
  const backend = fakeBackend({
    webmcpCall: async (tabId, name, input) => {
      if (outcome instanceof Error) throw outcome
      calls.push({ tabId, name, input })
      return outcome
    },
  })
  return { backend, calls }
}

/** Run `chrome_webmcp_list` and return the model-facing JSON object. */
async function runList(backend: BrowserBackend, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await toolFor(backend, 'chrome_webmcp_list').execute(args, {} as never) as Record<string, unknown>
}

/** Run `chrome_webmcp_call` and return the model-facing JSON object. */
async function runCall(backend: BrowserBackend, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await toolFor(backend, 'chrome_webmcp_call').execute(args, {} as never) as Record<string, unknown>
}

describe('chrome_webmcp_list', () => {
  it('returns the listing as JSON for the tab it read', async () => {
    const backend = fakeBackend({ webmcpTools: async () => ({ available: true, tools: [SEARCH_TOOL] }) })
    await expect(runList(backend, { tabId: '7' }))
      .resolves.toEqual({ tabId: '7', available: true, tools: [SEARCH_TOOL] })
  })

  it('keeps the reason when the browser has no WebMCP surface', async () => {
    const backend = fakeBackend({
      webmcpTools: async () => ({ available: false, reason: 'Chrome 未启用 WebMCP', tools: [] }),
    })
    await expect(runList(backend, { tabId: '7' }))
      .resolves.toEqual({ tabId: '7', available: false, tools: [], reason: 'Chrome 未启用 WebMCP' })
  })

  it('reports the API surface as available when the page registers no tools', async () => {
    // `available: true` + `tools: []` is a page that has `document.modelContext`
    // but declares nothing right now — not a browser without WebMCP.
    const backend = fakeBackend({ webmcpTools: async () => ({ available: true, tools: [] }) })
    await expect(runList(backend, { tabId: '7' }))
      .resolves.toEqual({ tabId: '7', available: true, tools: [] })
  })

  it('reads the active tab when no tab id is given', async () => {
    const backend = fakeBackend()
    await expect(runList(backend, {}))
      .resolves.toEqual({ tabId: '1', available: false, tools: [], reason: 'test backend' })
  })
})

describe('chrome_webmcp_call', () => {
  it('passes the tool name and its input object to the backend and returns the result as JSON text', async () => {
    // Chrome's `executeTool` serializes an object return value to a JSON string
    // before it reaches the host, and the tool layer clips it as JSON text: a
    // consumer that expected an object would read `undefined` fields.
    const recorder = callRecorder({ tool: 'search', result: { hits: 2 } })
    const value = await runCall(recorder.backend, { tabId: '7', name: 'search', input: { q: '手机' } })
    expect(recorder.calls).toEqual([{ tabId: '7', name: 'search', input: { q: '手机' } }])
    expect(value).toMatchObject({ tabId: '7', tool: 'search' })
    expect(typeof value.result).toBe('string')
    expect(JSON.parse(String(value.result))).toEqual({ hits: 2 })
  })

  it('leaves a page result that already arrives as JSON text unescaped', async () => {
    // Chrome's `executeTool` serializes an object return value to a JSON string
    // before it reaches the host. Running clipJson on that string would JSON-
    // encode it a second time, so the text is clipped as text instead: the
    // model sees the page's own JSON and parses it once.
    const serialized = '{"background":"blue","count":1}'
    const recorder = callRecorder({ tool: 'applyTheme', result: serialized })
    const value = await runCall(recorder.backend, { tabId: '7', name: 'applyTheme' })
    expect(value.result).toBe(serialized)
    expect(JSON.parse(serialized)).toEqual({ background: 'blue', count: 1 })
  })

  it('sends an empty input object when the tool takes no arguments', async () => {
    const recorder = callRecorder({ tool: 'search', result: null })
    const value = await runCall(recorder.backend, { name: 'search' })
    expect(recorder.calls).toEqual([{ tabId: '1', name: 'search', input: {} }])
    expect(value).toEqual({ tabId: '1', tool: 'search', result: 'null' })
  })

  it('reports a pending activation with the note, never as a result', async () => {
    const withNote = callRecorder({ tool: 'checkout', pending: true, note: '请点击提交' })
    await expect(runCall(withNote.backend, { tabId: '7', name: 'checkout' }))
      .resolves.toEqual({ tabId: '7', tool: 'checkout', pending: true, note: '请点击提交' })

    const withoutNote = callRecorder({ tool: 'checkout', pending: true })
    await expect(runCall(withoutNote.backend, { tabId: '7', name: 'checkout' }))
      .resolves.toEqual({ tabId: '7', tool: 'checkout', pending: true })
  })

  it('reports a navigation instead of a result', async () => {
    const recorder = callRecorder({ tool: 'go', navigated: true })
    await expect(runCall(recorder.backend, { tabId: '7', name: 'go' }))
      .resolves.toEqual({ tabId: '7', tool: 'go', navigated: true })
  })

  it('clips an oversized string result as text, keeping it one JSON layer deep', async () => {
    const result = 'x'.repeat(200_050)
    const recorder = callRecorder({ tool: 'scrape', result })
    const value = await runCall(recorder.backend, { tabId: '7', name: 'scrape' })
    expect(String(value.result)).toContain('…[truncated: 200050 chars total]')
    expect(String(value.result).length).toBeLessThan(200_100)
  })

  it('clips an oversized object result as bounded JSON text', async () => {
    const recorder = callRecorder({ tool: 'scrape', result: { text: 'x'.repeat(200_050) } })
    const value = await runCall(recorder.backend, { tabId: '7', name: 'scrape' })
    expect(String(value.result).endsWith('…[truncated]')).toBe(true)
    expect(String(value.result).length).toBeLessThan(200_100)
  })

  it('propagates the page error so the model can pick another tool', async () => {
    const recorder = callRecorder(new Error('当前页面没有名为 "nope" 的 WebMCP 工具;可用: search'))
    await expect(runCall(recorder.backend, { tabId: '7', name: 'nope' }))
      .rejects.toThrow(/可用: search/u)
  })
})
