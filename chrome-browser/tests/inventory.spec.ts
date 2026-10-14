/**
 * Page perception: what `chrome_read` reports about a page's structure, and the
 * defensive mapping between a page's answer and the host's types.
 *
 * The agreement between the host's inventory expression and the shipped
 * extension's copy is verified against a real page in tests/smoke.spec.ts —
 * both implementations run there and must produce the same listing.
 */
import { describe, expect, it } from 'vitest'
import { EXTENSION_SOURCE } from './support/extension-source.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { BackendInventory, BackendRead, BackendTab, BrowserBackend, ClickOutcome } from '../src/backend.ts'
import { mapInventory } from '../src/backend.ts'
import { resolveChromeConfig } from '../src/chrome.ts'
import { ConsoleLog } from '../src/console-log.ts'
import { HelpChannel } from '../src/help.ts'
import { INVENTORY_LIMIT, INTERACTIVE_SELECTOR } from '../src/expressions.ts'
import { chromeToolDefinitions } from '../src/tools.ts'

const EMPTY_CLICK: ClickOutcome = {
  matched: 0, clicked: 0, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0,
}

interface Host {
  backend: BrowserBackend
  inventory: BackendInventory
  read: BackendRead
}

/** A backend answering with one fixed inventory and one fixed page read. */
function host(): Host {
  const state: Host = {
    inventory: { title: '', url: '', matched: 0, items: [] },
    read: { title: 'T', url: 'https://e.test/', text: '', html: '' },
    backend: undefined as unknown as BrowserBackend,
  }
  const tab: BackendTab = { id: '7', title: 'T', url: 'https://e.test/', active: true, favicon: '' }
  state.backend = {
    lastEvalWorld: undefined,
    ensure: async () => {},
    activeTabId: async () => tab.id,
    listTabs: async () => [tab],
    openTab: async () => tab,
    closeTab: async () => {},
    read: async () => state.read,
    inventory: async () => state.inventory,
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
  }
  return state
}

function tools(backend: BrowserBackend, limit = 30_000): Map<string, ToolDefinition> {
  return new Map(
    chromeToolDefinitions(backend, resolveChromeConfig({ readTextLimit: limit }), new ConsoleLog(), new HelpChannel())
      .map(definition => [definition.name, definition]),
  )
}

async function read(
  state: Host,
  args: Record<string, unknown>,
  limit = 30_000,
): Promise<Record<string, unknown>> {
  const tool = tools(state.backend, limit).get('chrome_read')
  if (tool === undefined) throw new Error('chrome_read is not registered')
  return await tool.execute(args as never, {} as never) as unknown as Record<string, unknown>
}

describe('mapInventory', () => {
  it('passes a well-formed listing through', () => {
    expect(mapInventory({
      title: 'T',
      url: 'https://e.test/',
      matched: 2,
      items: [
        { selector: '#go', role: 'button', name: 'Go', inView: true, disabled: false, covered: false },
        { selector: 'input', role: 'input', name: '', inView: false, disabled: true, covered: true },
      ],
    })).toEqual({
      title: 'T',
      url: 'https://e.test/',
      matched: 2,
      items: [
        { selector: '#go', role: 'button', name: 'Go', inView: true, disabled: false, covered: false },
        { selector: 'input', role: 'input', name: '', inView: false, disabled: true, covered: true },
      ],
    })
  })

  it('answers an unusable reply with an empty listing rather than an error', () => {
    const empty = { title: '', url: '', matched: 0, items: [] }
    expect(mapInventory(undefined)).toEqual(empty)
    expect(mapInventory('not an object')).toEqual(empty)
    expect(mapInventory({ items: 'not an array' })).toEqual(empty)
  })

  it('drops entries it cannot address and defaults the rest', () => {
    const mapped = mapInventory({ matched: 3, items: [null, 'x', { role: 'button' }, { selector: '#ok' }] })
    expect(mapped.matched).toBe(3)
    expect(mapped.items).toEqual([
      { selector: '#ok', role: '', name: '', inView: false, disabled: false, covered: false },
    ])
  })

  it('reads only an exact true as a flag', () => {
    const mapped = mapInventory({ items: [{ selector: '#a', inView: 'yes', disabled: 1, covered: true }] })
    expect(mapped.items[0]).toMatchObject({ inView: false, disabled: false, covered: true })
  })
})

describe('chrome_read in interactive mode', () => {
  it('reports the listing with the page identity and the cap', async () => {
    const state = host()
    state.inventory = {
      title: '示例页',
      url: 'https://e.test/form',
      matched: 3,
      items: [
        { selector: '#submit', role: 'button', name: '提交', inView: true, disabled: false, covered: false },
      ],
    }
    const value = await read(state, { tabId: '7', mode: 'interactive' })
    expect(value).toEqual({
      tabId: '7',
      mode: 'interactive',
      title: '示例页',
      url: 'https://e.test/form',
      matched: 3,
      shown: 1,
      items: [{ selector: '#submit', role: 'button', name: '提交', inView: true, disabled: false, covered: false }],
    })
  })

  it('does not read the page text at all', async () => {
    const state = host()
    state.read = { title: 'T', url: 'https://e.test/', text: 'x'.repeat(50_000), html: '' }
    const value = await read(state, { tabId: '7', mode: 'interactive' })
    expect(value.text).toBeUndefined()
  })
})

describe('chrome_read in text mode', () => {
  it('defaults to a text window with the page identity', async () => {
    const state = host()
    state.read = { title: 'T', url: 'https://e.test/', text: 'hello', html: '' }
    expect(await read(state, { tabId: '7' })).toMatchObject({
      mode: 'text', title: 'T', url: 'https://e.test/', text: 'hello', textChars: 5, offset: 0, textTruncated: false,
    })
  })

  it('marks a window that stopped short and where to continue', async () => {
    const state = host()
    state.read = { title: 'T', url: 'https://e.test/', text: 'abcdefghij', html: '' }
    const value = await read(state, { tabId: '7' }, 4)
    expect(value).toMatchObject({ text: 'abcd\n…[window 0-4 of 10 code points; pass offset=4 for the rest]', nextOffset: 4, textChars: 10, textTruncated: true, offset: 0 })
  })

  it('continues from offset to the end and stops asking for more', async () => {
    const state = host()
    state.read = { title: 'T', url: 'https://e.test/', text: 'abcdefghij', html: '' }
    const value = await read(state, { tabId: '7', offset: 8 }, 4)
    expect(value).toMatchObject({ text: 'ij', offset: 8, textChars: 10, textTruncated: false })
    expect(value.nextOffset).toBeUndefined()
  })

  it('walks a long page window by window without losing text', async () => {
    const state = host()
    state.read = { title: 'T', url: 'https://e.test/', text: 'x'.repeat(25), html: '' }
    const seen: string[] = []
    let offset = 0
    for (let guard = 0; guard < 20; guard += 1) {
      const value = await read(state, { tabId: '7', offset }, 10)
      // The continuation marker is appended to the window; the text is what
      // precedes it.
      seen.push(String(value.text).replace(/\n…\[window[\s\S]*$/u, ''))
      if (value.nextOffset === undefined) break
      offset = Number(value.nextOffset)
    }
    expect(seen.join('')).toBe('x'.repeat(25))
  })
})

describe('the inventory selector', () => {
  it('covers the controls a reader acts on', () => {
    for (const token of ['a[href]', 'button', 'input', 'select', 'textarea', '[role=button]', '[contenteditable=true]']) {
      expect(INTERACTIVE_SELECTOR).toContain(token)
    }
  })

  it('is capped, so a page cannot make the listing unbounded', () => {
    expect(INVENTORY_LIMIT).toBeGreaterThan(0)
    expect(INVENTORY_LIMIT).toBeLessThanOrEqual(500)
  })
})

describe('mirrored inventory constants', () => {
  it('keeps the extension selector identical to the host one', () => {
    // A truncated value silently narrows what the inventory can see, and the
    // host-side tests never read the extension's copy.
    const declared = /const INVENTORY_SELECTOR = ([\s\S]*?)\n\n/u.exec(EXTENSION_SOURCE)?.[1] ?? ''
    // The literal is a `+`-joined run of single-quoted segments; concatenating
    // them is the value without evaluating the file.
    const value = [...declared.matchAll(/'([^']*)'/gu)].map(segment => segment[1]).join('')
    expect(value).toBe(INTERACTIVE_SELECTOR)
  })
})
