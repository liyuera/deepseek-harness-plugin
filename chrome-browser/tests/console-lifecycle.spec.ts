/**
 * Exiting console capture.
 *
 * A console capture holds Chrome's debugger, and Chrome shows its "debugging
 * this browser" bar for as long as that attachment lives. `action: stop` is the
 * explicit exit; these are the automatic ones that have to exist because a
 * stopped model or a dead host will never send it:
 *
 * - `console-sync`: a reconnected host names the captures it still holds, so a
 *   capture re-armed from a *previous* host process is detached instead of
 *   quietly receiving into a buffer that no longer exists.
 * - `releaseCapturesIfHostGone`: no host seen for the grace bound means nobody
 *   will ever read the capture; detach it and clear the persisted set.
 *
 * The alarm and boot call both of these, so they also run after Chrome
 * suspended the worker — a plain timer would die with it.
 */
import { describe, expect, it } from 'vitest'
import { loadExtensionFunction } from './support/extension-source.ts'

/** One in-memory `chrome.storage.session` plus a recording `chrome.debugger`. */
function stub(initial: Record<string, unknown> = {}): {
  chrome: unknown
  store: Map<string, unknown>
  detached: number[]
  attached: number[]
} {
  const store = new Map<string, unknown>(Object.entries(initial))
  const detached: number[] = []
  const attached: number[] = []
  return {
    store,
    detached,
    attached,
    chrome: {
      runtime: { id: 'our-extension' },
      storage: {
        session: {
          get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
          set: async (values: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(values)) store.set(key, value)
          },
        },
      },
      debugger: {
        getTargets: async () => [],
        attach: async ({ tabId }: { tabId: number }) => { attached.push(tabId) },
        detach: async ({ tabId }: { tabId: number }) => { detached.push(tabId) },
        sendCommand: async () => ({}),
      },
    },
  }
}

/** `syncConsole` as the extension ships it, over one stub `chrome`. */
function syncConsole(chrome: unknown): (tabs: unknown) => Promise<{ kept: number; dropped: number; restored: number }> {
  return loadExtensionFunction<(
    tabs: unknown
  ) => Promise<{ kept: number; dropped: number; restored: number }>>(
    [
      'CONSOLE_TABS_KEY',
      'HOST_SEEN_KEY',
      'CONSOLE_BRIDGE_GRACE_MS',
      'consoleTabs',
      'setConsoleTabs',
      'startConsole',
      'syncConsole',
    ],
    'syncConsole',
    ['chrome', 'trace'],
  )(chrome, () => {})
}

/** `releaseCapturesIfHostGone` as the extension ships it, over one stub `chrome`. */
function releaseCapturesIfHostGone(chrome: unknown): () => Promise<void> {
  return loadExtensionFunction<() => Promise<void>>(
    [
      'CONSOLE_TABS_KEY',
      'HOST_SEEN_KEY',
      'CONSOLE_BRIDGE_GRACE_MS',
      'consoleTabs',
      'setConsoleTabs',
      'releaseCapturesIfHostGone',
    ],
    'releaseCapturesIfHostGone',
    ['chrome', 'trace'],
  )(chrome, () => {})
}

describe('console-sync', () => {
  it('drops captures the host does not know about', async () => {
    // The host restarted: its capture set is empty, so every re-armed capture
    // is a leftover from the previous process.
    const fixture = stub({ consoleTabs: [7, 8] })
    await expect(syncConsole(fixture.chrome)([])).resolves.toMatchObject({ dropped: 2 })
    expect(fixture.detached).toEqual([7, 8])
    expect(fixture.store.get('consoleTabs')).toEqual([])
  })

  it('keeps captures the host still holds', async () => {
    const fixture = stub({ consoleTabs: [7, 8] })
    await expect(syncConsole(fixture.chrome)([7])).resolves.toMatchObject({ kept: 1, dropped: 1 })
    expect(fixture.detached).toEqual([8])
    expect(fixture.store.get('consoleTabs')).toEqual([7])
  })

  it('re-attaches a capture the extension lost but the host still holds', async () => {
    // Worker restarted while the host kept its buffer: the host is the source
    // of truth, so the capture must come back rather than silently stop.
    const fixture = stub({ consoleTabs: [] })
    await expect(syncConsole(fixture.chrome)([7])).resolves.toMatchObject({ restored: 1 })
    expect(fixture.attached).toEqual([7])
    expect(fixture.store.get('consoleTabs')).toEqual([7])
  })
})

describe('releaseCapturesIfHostGone', () => {
  it('detaches every capture when the host has been gone past the grace bound', async () => {
    const fixture = stub({ consoleTabs: [7, 8], hostSeenAt: Date.now() - 61_000 })
    await releaseCapturesIfHostGone(fixture.chrome)()
    expect(fixture.detached).toEqual([7, 8])
    expect(fixture.store.get('consoleTabs')).toEqual([])
  })

  it('leaves captures alone while the host is still being heard from', async () => {
    const fixture = stub({ consoleTabs: [7], hostSeenAt: Date.now() })
    await releaseCapturesIfHostGone(fixture.chrome)()
    expect(fixture.detached).toEqual([])
    expect(fixture.store.get('consoleTabs')).toEqual([7])
  })

  it('treats a capture with no host record as stale', async () => {
    // storage.session survived a browser crash but the host record did not:
    // nobody is coming back for this capture.
    const fixture = stub({ consoleTabs: [7] })
    await releaseCapturesIfHostGone(fixture.chrome)()
    expect(fixture.detached).toEqual([7])
  })

  it('does nothing when no capture is persisted', async () => {
    const fixture = stub({ consoleTabs: [], hostSeenAt: 0 })
    await releaseCapturesIfHostGone(fixture.chrome)()
    expect(fixture.detached).toEqual([])
  })
})
