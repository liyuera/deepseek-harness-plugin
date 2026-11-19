import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackendRegistry } from '../src/backend-registry.ts'
import type { BrowserBackend } from '../src/backend.ts'
import type { ResolvedChromeConfig } from '../src/chrome.ts'

/** Minimal resolved config for sandbox-mode tests. */
function sandboxConfig(over: Partial<ResolvedChromeConfig> = {}): ResolvedChromeConfig {
  return {
    backend: 'sandbox', port: 9222, profileDir: '/tmp/p', mode: 'owned',
    autoRelaunch: false, attachOnly: false, timeoutMs: 15000, readTextLimit: 30000,
    waitLoadMs: 8000, screenshotDir: '/tmp/s', consoleIdleMs: 300000,
    bridgePort: 21987, sandboxMaxConcurrent: 2, sandboxIdleMs: 600000, sandboxHeadless: false,
    ...over,
  }
}

function fakeBackend(): BrowserBackend & { disposed: boolean } {
  return {
    disposed: false,
    ensure: async () => {},
    activeTabId: async () => 't',
    listTabs: async () => [],
    openTab: async () => ({ id: 't', title: '', url: '', active: true, favicon: '' }),
    closeTab: async () => {},
    read: async () => ({ title: '', url: '', text: '', html: '' }),
    inventory: async () => ({ title: '', url: '', matched: 0, items: [] }),
    navigate: async () => {},
    waitForLoad: async () => {},
    evaluate: async () => undefined,
    lastEvalWorld: undefined,
    webmcpTools: async () => ({ available: false, tools: [] }),
    webmcpCall: async () => ({ tool: '' }),
    click: async () => ({ matched: 0, clicked: 0, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0 }),
    hover: async () => ({ matched: 0, hovered: false }),
    press: async () => ({ found: false, pressed: false, submitted: false }),
    select: async () => ({ matched: 0, changed: false, value: '', options: [] }),
    waitFor: async () => false,
    type: async () => {},
    screenshot: async () => ({ data: '' }),
    startConsole: async () => {},
    stopConsole: async () => {},
    dispose() { this.disposed = true },
  }
}

const execOf = (id: string): unknown => ({ agent: { id } })

describe('BackendRegistry', () => {
  afterEach(() => vi.useRealTimers())

  it('returns shared backend when backend is not sandbox', () => {
    const shared = fakeBackend()
    const reg = new BackendRegistry(sandboxConfig({ backend: 'extension' }), shared, () => fakeBackend())
    expect(reg.resolve(execOf('a1'))).toBe(shared)
    expect(reg.resolve({})).toBe(shared)
  })

  it('returns shared backend for agent-less calls in sandbox mode', () => {
    const shared = fakeBackend()
    const reg = new BackendRegistry(sandboxConfig(), shared, () => fakeBackend())
    expect(reg.resolve({})).toBe(shared)
  })

  it('creates one sandbox per agent and reuses it', () => {
    const shared = fakeBackend()
    const made: string[] = []
    const reg = new BackendRegistry(sandboxConfig(), shared, () => {
      made.push('x')
      return fakeBackend()
    })
    const a = reg.resolve(execOf('a1'))
    const b = reg.resolve(execOf('a1'))
    expect(a).toBe(b)
    expect(made).toHaveLength(1)
    expect(reg.resolve(execOf('a2'))).not.toBe(a)
    expect(made).toHaveLength(2)
  })

  it('reuses freed ports', () => {
    const shared = fakeBackend()
    const ports: number[] = []
    const reg = new BackendRegistry(sandboxConfig({ sandboxMaxConcurrent: 4 }), shared, (cfg) => {
      ports.push(cfg.port)
      return fakeBackend()
    })
    reg.resolve(execOf('a1'))
    reg.resolve(execOf('a2'))
    reg.release('a1')
    reg.resolve(execOf('a3'))
    expect(ports).toEqual([9222, 9223, 9222])
  })

  it('release disposes and is idempotent', () => {
    const shared = fakeBackend()
    const sandbox = fakeBackend()
    const reg = new BackendRegistry(sandboxConfig(), shared, () => sandbox)
    reg.resolve(execOf('a1'))
    reg.release('a1')
    expect(sandbox.disposed).toBe(true)
    reg.release('a1') // no throw
  })

  it('rejects when at capacity with no idle lease to reclaim', () => {
    const shared = fakeBackend()
    const reg = new BackendRegistry(sandboxConfig({ sandboxMaxConcurrent: 2 }), shared, () => fakeBackend())
    reg.resolve(execOf('a1'))
    reg.resolve(execOf('a2'))
    expect(() => reg.resolve(execOf('a3'))).toThrow(/上限/)
  })

  it('reclaims an idle lease instead of rejecting', () => {
    vi.useFakeTimers()
    const shared = fakeBackend()
    const created: Array<BrowserBackend & { disposed: boolean }> = []
    const reg = new BackendRegistry(sandboxConfig({ sandboxMaxConcurrent: 2, sandboxIdleMs: 1000 }), shared, () => {
      const backend = fakeBackend()
      created.push(backend)
      return backend
    })
    reg.resolve(execOf('a1'))
    reg.resolve(execOf('a2'))
    vi.advanceTimersByTime(2000)
    const a3 = reg.resolve(execOf('a3'))
    expect(a3).toBeDefined()
    expect(created.some(backend => backend.disposed)).toBe(true)
  })

  it('never reclaims when sandboxIdleMs is 0', () => {
    vi.useFakeTimers()
    const shared = fakeBackend()
    const reg = new BackendRegistry(sandboxConfig({ sandboxMaxConcurrent: 1, sandboxIdleMs: 0 }), shared, () => fakeBackend())
    reg.resolve(execOf('a1'))
    vi.advanceTimersByTime(10 * 60_000)
    expect(() => reg.resolve(execOf('a2'))).toThrow(/上限/)
  })

  it('synchronously sweeps idle leases instead of relying on the timer', () => {
    vi.useFakeTimers()
    const shared = fakeBackend()
    const created: Array<BrowserBackend & { disposed: boolean }> = []
    const reg = new BackendRegistry(sandboxConfig({ sandboxMaxConcurrent: 2, sandboxIdleMs: 1000 }), shared, () => {
      const backend = fakeBackend()
      created.push(backend)
      return backend
    })
    reg.resolve(execOf('a1'))
    reg.resolve(execOf('a2'))
    vi.setSystemTime(Date.now() + 2000)
    const a3 = reg.resolve(execOf('a3'))
    expect(a3).toBeDefined()
    expect(created.some(backend => backend.disposed)).toBe(true)
  })

  it('dispose releases every sandbox and the shared backend', () => {
    const shared = fakeBackend()
    const reg = new BackendRegistry(sandboxConfig({ sandboxMaxConcurrent: 4 }), shared, () => fakeBackend())
    reg.resolve(execOf('a1'))
    reg.resolve(execOf('a2'))
    reg.dispose()
    expect(shared.disposed).toBe(true)
  })
})
