/**
 * Load waiting at the tool level: `chrome_open` must not hand back a tab whose
 * document has not committed, and `chrome_navigate` must stay consistent with
 * it. Both wait by default and both can be told not to.
 */
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { BackendTab, BrowserBackend, ClickOutcome } from '../src/backend.ts'
import { resolveChromeConfig } from '../src/chrome.ts'
import { ConsoleLog } from '../src/console-log.ts'
import { HelpChannel } from '../src/help.ts'
import { chromeToolDefinitions } from '../src/tools.ts'

const CREATED_TITLE = '创建时标题'

const EMPTY_CLICK: ClickOutcome = {
  matched: 0, clicked: 0, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0,
}

interface Recorder {
  backend: BrowserBackend
  /** Every backend call, in order. */
  readonly calls: string[]
  /** What `listTabs` answers; tests set it to simulate the post-load listing. */
  listed: BackendTab[]
  /** When set, `listTabs` throws it. */
  listFailure: Error | undefined
}

/** A backend that records the operations the tools ask for. */
function recorder(): Recorder {
  const calls: string[] = []
  const state: Recorder = {
    calls,
    listed: [],
    listFailure: undefined,
    backend: undefined as unknown as BrowserBackend,
  }
  state.backend = {
    lastEvalWorld: undefined,
    ensure: async () => {},
    activeTabId: async () => '1',
    listTabs: async () => {
      calls.push('listTabs')
      if (state.listFailure !== undefined) throw state.listFailure
      return state.listed
    },
    closeTab: async () => {},
    openTab: async (url: string) => {
      calls.push(`open:${url}`)
      return { id: '9', title: CREATED_TITLE, url, active: true, favicon: '' }
    },
    read: async () => ({ title: '', url: '', text: '', html: '' }),
    inventory: async () => ({ title: '', url: '', matched: 0, items: [] }),
    navigate: async (tabId: string, url: string, waitLoad: boolean, waitLoadMs: number) => {
      calls.push(`navigate:${tabId}:${url}:${String(waitLoad)}:${String(waitLoadMs)}`)
    },
    waitForLoad: async (tabId: string, waitLoadMs: number) => {
      calls.push(`waitForLoad:${tabId}:${String(waitLoadMs)}`)
    },
    evaluate: async () => undefined,
    webmcpTools: async () => ({ available: false, reason: 'test backend', tools: [] }),
    webmcpCall: async () => { throw new Error('no WebMCP tool in the test backend') },

    click: async () => EMPTY_CLICK,
    hover: async () => ({ matched: 0, hovered: false }),
    press: async () => ({ found: true, pressed: true, submitted: false }),
    select: async () => ({ matched: 1, changed: true, value: 'x', options: ['x'] }),
    waitFor: async () => false,
    type: async () => {},
    screenshot: async () => ({ data: '' }),
    startConsole: async (tabId: string) => { calls.push(`startConsole:${tabId}`) },
    stopConsole: async (tabId: string) => { calls.push(`stopConsole:${tabId}`) },
    dispose: () => {},
  }
  return state
}

function tools(backend: BrowserBackend): Map<string, ToolDefinition> {
  const config = resolveChromeConfig({})
  return new Map(chromeToolDefinitions(backend, config, new ConsoleLog(), new HelpChannel()).map(entry => [entry.name, entry]))
}

/** The listed tab for id 9, as a post-load listing would report it. */
function loadedTab(): BackendTab {
  return { id: '9', title: '真实标题', url: 'https://example.test/', active: true, favicon: '' }
}

describe('chrome_open', () => {
  it('waits for the load and reports the loaded identity', async () => {
    const host = recorder()
    host.listed = [loadedTab()]
    const value = await tools(host.backend).get('chrome_open')?.execute({ url: 'https://example.test/' }, {} as never)

    expect(host.calls).toEqual(['open:https://example.test/', 'waitForLoad:9:8000', 'listTabs'])
    expect(value).toMatchObject({ tabId: '9', title: '真实标题', url: 'https://example.test/' })
  })

  it('returns as soon as the tab exists when waitLoad is false', async () => {
    const host = recorder()
    host.listed = [loadedTab()]
    const value = await tools(host.backend).get('chrome_open')
      ?.execute({ url: 'https://example.test/', waitLoad: false }, {} as never)

    expect(host.calls).toEqual(['open:https://example.test/'])
    expect(value).toMatchObject({ tabId: '9', title: CREATED_TITLE })
  })

  it('falls back to the creation view when the tab is no longer listed', async () => {
    const host = recorder()
    host.listed = []
    const value = await tools(host.backend).get('chrome_open')?.execute({ url: 'https://example.test/' }, {} as never)
    expect(value).toMatchObject({ tabId: '9', title: CREATED_TITLE })
  })

  it('still reports the open when the follow-up listing fails', async () => {
    const host = recorder()
    host.listFailure = new Error('bridge went away')
    const value = await tools(host.backend).get('chrome_open')?.execute({ url: 'https://example.test/' }, {} as never)
    expect(value).toMatchObject({ tabId: '9', title: CREATED_TITLE })
  })

  it('opens about:blank without settling the wait it cannot perform', async () => {
    // A blank tab has nothing to load, and waiting would evaluate in a page the
    // extension cannot inject into — the default call used to fail outright.
    const host = recorder()
    host.listed = []
    const value = await tools(host.backend).get('chrome_open')?.execute({}, {} as never)
    expect(host.calls).toContain('open:about:blank')
    expect(host.calls).not.toContain('waitForLoad:9:8000')
    expect(value).toMatchObject({ tabId: '9' })
  })
})

describe('chrome_navigate', () => {
  it('waits for the load by default', async () => {
    const host = recorder()
    await tools(host.backend).get('chrome_navigate')?.execute({ tabId: '9', url: 'https://example.test/' }, {} as never)
    expect(host.calls).toEqual(['navigate:9:https://example.test/:true:8000'])
  })

  it('does not wait when waitLoad is false', async () => {
    const host = recorder()
    await tools(host.backend).get('chrome_navigate')
      ?.execute({ tabId: '9', url: 'https://example.test/', waitLoad: false }, {} as never)
    expect(host.calls).toEqual(['navigate:9:https://example.test/:false:8000'])
  })
})
