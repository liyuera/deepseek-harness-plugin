/**
 * Tool-level wiring for the per-agent backend registry: a tool call must drive
 * the backend resolved from ITS OWN execution context, not one captured when
 * the definitions were built.
 */
import { describe, expect, it, vi } from 'vitest'
import { chromeToolDefinitions } from '../src/tools.ts'
import type { BrowserBackend } from '../src/backend.ts'
import type { ResolvedChromeConfig } from '../src/chrome.ts'
import type { ConsoleLog } from '../src/console-log.ts'
import type { HelpChannel } from '../src/help.ts'

/** Fully-resolved plugin config, shaped like the real one. */
function config(over: Partial<ResolvedChromeConfig> = {}): ResolvedChromeConfig {
  return {
    backend: 'sandbox', port: 9222, profileDir: '/tmp/p', mode: 'owned',
    autoRelaunch: false, attachOnly: false, timeoutMs: 15000, readTextLimit: 30000,
    waitLoadMs: 8000, screenshotDir: '/tmp/s', consoleIdleMs: 300000,
    bridgePort: 21987, sandboxMaxConcurrent: 2, sandboxIdleMs: 600000, sandboxHeadless: false,
    ...over,
  }
}

/** One fake backend whose tabs identify it, plus the spy the test asserts on. */
function stubBackend(id: string): { backend: BrowserBackend; listTabs: ReturnType<typeof vi.fn> } {
  const listTabs = vi.fn(async () => [
    { id: `${id}-tab`, title: `${id} tab`, url: `https://${id}.example/`, active: true, favicon: '' },
  ])
  return { backend: { listTabs } as unknown as BrowserBackend, listTabs }
}

/** Execution context as the host shapes it, narrowed to what resolution reads. */
interface ExecLike {
  agent?: { id?: string }
}

describe('chromeToolDefinitions backend resolution', () => {
  it('drives the backend of the executing agent on every call', async () => {
    const a1 = stubBackend('a1')
    const b2 = stubBackend('b2')
    // Deliberately picks the backend from `exec`: a tool that captured one
    // backend when the definitions were built fails here.
    const resolve = vi.fn((exec: unknown): BrowserBackend => {
      return (exec as ExecLike).agent?.id === 'a1' ? a1.backend : b2.backend
    })
    const tools = chromeToolDefinitions(
      resolve,
      config(),
      {} as ConsoleLog,
      { request: async () => ({ completed: false }) } as unknown as HelpChannel,
    )
    const tabsTool = tools.find(tool => tool.name === 'chrome_tabs')
    expect(tabsTool, 'chrome_tabs is not registered').toBeDefined()

    const one = await tabsTool?.execute({}, { agent: { id: 'a1' } } as never)
    expect(a1.listTabs).toHaveBeenCalledTimes(1)
    expect(b2.listTabs).not.toHaveBeenCalled()
    expect((one as { tabs: Array<{ id: string }> }).tabs.map(tab => tab.id)).toEqual(['a1-tab'])

    const two = await tabsTool?.execute({}, { agent: { id: 'a2' } } as never)
    expect(a1.listTabs).toHaveBeenCalledTimes(1)
    expect(b2.listTabs).toHaveBeenCalledTimes(1)
    expect((two as { tabs: Array<{ id: string }> }).tabs.map(tab => tab.id)).toEqual(['b2-tab'])

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(resolve.mock.calls[0]?.[0]).toMatchObject({ agent: { id: 'a1' } })
    expect(resolve.mock.calls[1]?.[0]).toMatchObject({ agent: { id: 'a2' } })
  })
})
