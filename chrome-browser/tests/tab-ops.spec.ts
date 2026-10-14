/**
 * Closing a tab, and refusing to open one the plugin cannot drive.
 *
 * Both come from the same real-browser session: `chrome_open` happily created a
 * tab for a `data:` URL and every tool afterwards failed on it — reads,
 * evaluation and even navigation away, because the extension's host permissions
 * do not cover that scheme. Nothing could close it either, so retired test tabs
 * accumulated with no way to tidy them up.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { BackendTab, BrowserBackend, ClickOutcome } from '../src/backend.ts'
import { resolveChromeConfig } from '../src/chrome.ts'
import { ConsoleLog } from '../src/console-log.ts'
import { ActivityTracker, withActivity } from '../src/activity.ts'
import { HelpChannel } from '../src/help.ts'
import { chromeToolDefinitions } from '../src/tools.ts'

const EMPTY_CLICK: ClickOutcome = {
  matched: 0, clicked: 0, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0,
}

/** What the fake backend was asked to do. */
interface Calls {
  readonly opened: string[]
  readonly closed: string[]
  readonly navigated: Array<{ tabId: string; url: string }>
  readonly waitedForLoad: string[]
}

/** A backend that records opens, closes and navigations. */
function backend(): { backend: BrowserBackend; calls: Calls } {
  const tab: BackendTab = { id: '7', title: 'T', url: 'https://e.test/', active: true, favicon: '' }
  const calls: Calls = { opened: [], closed: [], navigated: [], waitedForLoad: [] }
  const value = {
    lastEvalWorld: undefined,
    ensure: async () => {},
    activeTabId: async () => tab.id,
    listTabs: async () => [tab],
    openTab: async (url: string) => {
      calls.opened.push(url)
      return tab
    },
    closeTab: async (tabId: string) => {
      calls.closed.push(tabId)
    },
    read: async () => ({ title: '', url: '', text: '', html: '' }),
    inventory: async () => ({ title: '', url: '', matched: 0, items: [] }),
    navigate: async (tabId: string, url: string) => {
      calls.navigated.push({ tabId, url })
    },
    waitForLoad: async (tabId: string) => {
      calls.waitedForLoad.push(tabId)
    },
    evaluate: async () => undefined,
    click: async () => EMPTY_CLICK,
    hover: async () => ({ matched: 0, hovered: false }),
    press: async () => ({ found: false, pressed: false, submitted: false }),
    select: async () => ({ matched: 0, changed: false, value: '', options: [] }),
    waitFor: async () => false,
    type: async () => {},
    screenshot: async () => ({ data: '' }),
    startConsole: async () => {},
    stopConsole: async () => {},
    dispose: () => {},
  } as unknown as BrowserBackend
  return { backend: value, calls }
}

/** One tool over a recording backend. */
function tool(name: string): { definition: ToolDefinition; calls: Calls } {
  const fixture = backend()
  const found = chromeToolDefinitions(
    fixture.backend, resolveChromeConfig({}), new ConsoleLog(), new HelpChannel(),
  ).find(definition => definition.name === name)
  if (found === undefined) throw new Error(`${name} is not registered`)
  return { definition: found, calls: fixture.calls }
}

describe('chrome_close', () => {
  it('closes the tab it was given', async () => {
    const { definition, calls } = tool('chrome_close')
    const value = await definition.execute({ tabId: '1178519964' }, {} as never) as { closed: boolean }
    expect(calls.closed).toEqual(['1178519964'])
    expect(value).toEqual({ tabId: '1178519964', closed: true })
  })

  it('refuses to guess, rather than closing whatever the user is looking at', async () => {
    // The registry rejects a call with the required argument missing, so the
    // tool's own guard only has to cover the `active` alias below.
    const { definition, calls } = tool('chrome_close')
    await expect(definition.execute({}, {} as never)).rejects.toThrow(/missing required/)
    expect(calls.closed).toEqual([])
  })

  it('refuses the active alias for the same reason', async () => {
    const { definition, calls } = tool('chrome_close')
    await expect(definition.execute({ tabId: 'active' }, {} as never)).rejects.toThrow(/exact tab id/)
    expect(calls.closed).toEqual([])
  })

  it('declares the tab id as required', () => {
    // Read from the schema the model is given, not from the declaration.
    const { definition } = tool('chrome_close')
    const schema = definition.parameters as { required?: string[] }
    expect(schema.required).toEqual(['tabId'])
  })
})

describe('chrome_open URL scheme', () => {
  it('opens an http(s) page', async () => {
    const { definition, calls } = tool('chrome_open')
    await definition.execute({ url: 'https://example.com' }, {} as never)
    expect(calls.opened).toEqual(['https://example.com'])
  })

  it('opens about:blank when no URL is given, without waiting for a page it cannot read', async () => {
    // Waiting evaluates in the new tab, and the extension cannot inject into
    // about:blank: the default call used to fail outright with Chrome's
    // "Cannot access about:blank at origin null".
    const { definition, calls } = tool('chrome_open')
    await expect(definition.execute({}, {} as never)).resolves.toMatchObject({ tabId: '7' })
    expect(calls.opened).toEqual(['about:blank'])
    expect(calls.waitedForLoad).toEqual([])
  })

  it('still waits for a real page', async () => {
    const { definition, calls } = tool('chrome_open')
    await definition.execute({ url: 'https://example.com' }, {} as never)
    expect(calls.waitedForLoad).toEqual(['7'])
  })

  it('refuses a data: URL before a tab exists for it', async () => {
    // The tab used to be created first and be unusable afterwards.
    const { definition, calls } = tool('chrome_open')
    await expect(definition.execute({ url: 'data:text/html,<h1>hi</h1>' }, {} as never))
      .rejects.toThrow(/cannot drive a data: URL/)
    expect(calls.opened).toEqual([])
  })

  it('refuses a privileged URL Chrome will not let the plugin into', async () => {
    const { definition, calls } = tool('chrome_open')
    await expect(definition.execute({ url: 'chrome://extensions' }, {} as never))
      .rejects.toThrow(/cannot drive a chrome: URL/)
    expect(calls.opened).toEqual([])
  })

  it('refuses something that is not a URL at all', async () => {
    const { definition, calls } = tool('chrome_open')
    await expect(definition.execute({ url: 'not a url' }, {} as never)).rejects.toThrow(/not a valid URL/)
    expect(calls.opened).toEqual([])
  })
})

describe('chrome_navigate URL scheme', () => {
  it('navigates to an http page', async () => {
    const { definition, calls } = tool('chrome_navigate')
    await definition.execute({ url: 'https://example.com', waitLoad: false }, {} as never)
    expect(calls.navigated).toEqual([{ tabId: '7', url: 'https://example.com' }])
  })

  it('refuses a data: URL, which would strand the tab', async () => {
    const { definition, calls } = tool('chrome_navigate')
    await expect(definition.execute({ url: 'data:text/html,<h1>hi</h1>' }, {} as never))
      .rejects.toThrow(/cannot drive a data: URL/)
    expect(calls.navigated).toEqual([])
  })

  it('refuses about:blank, which would discard the page and strand the tab', async () => {
    // Opening a blank tab is a staging move; navigating an existing tab to one
    // throws away what the user had there and leaves a tab nothing can read.
    const { definition, calls } = tool('chrome_navigate')
    await expect(definition.execute({ tabId: '7', url: 'about:blank' }, {} as never))
      .rejects.toThrow(/would discard the page/)
    expect(calls.navigated).toEqual([])
  })
})

describe('the status chip sees a close', () => {
  it('reports the call while it runs', async () => {
    const activity = new ActivityTracker()
    const fixture = backend()
    const definition = chromeToolDefinitions(
      fixture.backend, resolveChromeConfig({}), new ConsoleLog(), new HelpChannel(),
    ).find(entry => entry.name === 'chrome_close')
    const wrapped = withActivity(definition as ToolDefinition, activity)
    let during: ReturnType<ActivityTracker['snapshot']> | undefined
    const original = fixture.backend.closeTab
    vi.spyOn(fixture.backend, 'closeTab').mockImplementation(async (tabId: string) => {
      during = activity.snapshot()
      await original(tabId)
    })
    await wrapped.execute({ tabId: '9' }, {} as never)
    expect(during).toMatchObject({ phase: 'running', tool: 'chrome_close', tabId: '9' })
    expect(activity.snapshot()).toMatchObject({ phase: 'done', tabId: '9' })
  })
})
