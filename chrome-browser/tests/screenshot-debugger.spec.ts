/**
 * The extension's screenshot capture, run from the shipped source.
 *
 * It goes through `Page.captureScreenshot` on the debugger protocol rather than
 * `chrome.tabs.captureVisibleTab`. The visible-tab call reads back the window's
 * painted surface, which fails with "image readback failed" while the user is
 * looking at another application, and returns the PREVIOUS frame once the window
 * merely stops repainting — a stale image with nothing in the result to say so.
 * Both were observed against a real browser.
 *
 * The visible-window call survives as the fallback for the one case where the
 * debugger cannot be used at all — DevTools already owns the tab. That path and
 * its reported caveats live in tests/screenshot-fallback.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import { loadExtensionFunction } from './support/extension-source.ts'

/** `captureViaDebugger` as the extension ships it, over a stub `chrome`. */
function captureViaDebugger(chrome: unknown): (tabId: number) => Promise<string> {
  return loadExtensionFunction<(tabId: number) => Promise<string>>(
    ['SCREENSHOT_QUALITY', 'captureViaDebugger'],
    'captureViaDebugger',
    ['chrome'],
  )(chrome)
}

/** A `chrome` whose debugger answers one capture. */
function stub(
  outcome: { data?: unknown; attachFails?: boolean; foreign?: boolean; detachFails?: boolean } = {},
): { chrome: unknown; calls: string[]; params: Record<string, unknown>[] } {
  const calls: string[] = []
  const params: Record<string, unknown>[] = []
  return {
    calls,
    params,
    chrome: {
      runtime: { id: 'our-extension' },
      debugger: {
        getTargets: async () => (outcome.foreign === true
          ? [{ tabId: 7, attached: true, extensionId: 'someone-else' }]
          : []),
        attach: async () => {
          calls.push('attach')
          if (outcome.attachFails === true) throw new Error('Cannot attach to this target')
        },
        detach: async () => {
          calls.push('detach')
          if (outcome.detachFails === true) throw new Error('Debugger is not attached to the tab')
        },
        sendCommand: async (_target: unknown, method: string, request: Record<string, unknown>) => {
          calls.push(method)
          params.push(request)
          return 'data' in outcome ? { data: outcome.data } : { data: 'BASE64JPEG' }
        },
      },
    },
  }
}

describe('captureViaDebugger', () => {
  it('captures through Page.captureScreenshot and releases the debugger', async () => {
    const fixture = stub()
    await expect(captureViaDebugger(fixture.chrome)(7)).resolves.toBe('BASE64JPEG')
    expect(fixture.calls).toEqual(['attach', 'Page.captureScreenshot', 'detach'])
  })

  it('asks for a bounded JPEG rather than a full-resolution PNG', async () => {
    // PNG of a large page is tens of MB of base64, which is what OOM-killed the
    // worker mid-send on the visible-tab path.
    const fixture = stub()
    await captureViaDebugger(fixture.chrome)(7)
    expect(fixture.params[0]).toEqual({ format: 'jpeg', quality: 75, captureBeyondViewport: false })
  })

  it('reuses a debugger session console capture already holds', async () => {
    const fixture = stub()
    const chrome = fixture.chrome as { debugger: Record<string, unknown> }
    await captureViaDebugger({
      ...(fixture.chrome as object),
      debugger: { ...chrome.debugger, getTargets: async () => [{ tabId: 7, attached: true, extensionId: 'our-extension' }] },
    })(7)
    expect(fixture.calls).toEqual(['Page.captureScreenshot'])
  })

  it('refuses a tab another debugger owns, naming DevTools', async () => {
    const fixture = stub({ foreign: true })
    await expect(captureViaDebugger(fixture.chrome)(7)).rejects.toThrow(/DevTools/)
    expect(fixture.calls).toEqual([])
  })

  it('reports an empty capture instead of uploading nothing', async () => {
    const fixture = stub({ data: '' })
    await expect(captureViaDebugger(fixture.chrome)(7)).rejects.toThrow(/没有返回图像数据/)
    // The debugger is still released on the failure path.
    expect(fixture.calls).toContain('detach')
  })

  it('reports an attach failure as it stands', async () => {
    const fixture = stub({ attachFails: true })
    await expect(captureViaDebugger(fixture.chrome)(7)).rejects.toThrow(/Cannot attach/)
  })

  it('ignores a detach that had nothing to detach', async () => {
    const fixture = stub({ detachFails: true })
    await expect(captureViaDebugger(fixture.chrome)(7)).resolves.toBe('BASE64JPEG')
  })

  it('rejects a tab id that is not a number', async () => {
    const fixture = stub()
    await expect(captureViaDebugger(fixture.chrome)(Number('nope'))).rejects.toThrow(/无效的标签页 id/)
  })
})
