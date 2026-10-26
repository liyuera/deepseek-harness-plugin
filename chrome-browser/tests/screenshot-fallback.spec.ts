/**
 * Screenshot fallback when DevTools owns the tab's debugger.
 *
 * `chrome.debugger` cannot attach to a tab somebody else is already debugging,
 * and having DevTools open is exactly when a screenshot is most useful. The
 * extension then captures the window's visible tab instead — and has to say so:
 * that capture is viewport-only, can be a stale frame, and cannot honour
 * `fullPage` / `selector`. A viewport silently standing in for a whole page is
 * the failure this plugin elsewhere refuses to ship.
 */
import { describe, expect, it } from 'vitest'
import { loadExtensionFunction } from './support/extension-source.ts'

/** One fallback-aware capture, as `takeScreenshot` returns it. */
type Capture = (tabId: number, options?: { fullPage?: boolean; selector?: string }) => Promise<{
  dataUrl: string
  fallback: boolean
  viewportOnly: boolean
}>

/** The extension declarations `takeScreenshot` needs, in dependency order. */
const DECLARATIONS = [
  'SCREENSHOT_QUALITY',
  'VISIBLE_CAPTURE_TIMEOUT_MS',
  'DEBUGGER_OWNED',
  'debuggerOwnedByDevTools',
  'captureVisibleTab',
  'captureViaDebugger',
  'takeScreenshot',
]

/** `takeScreenshot` as the extension ships it, over a stub `chrome`. */
function takeScreenshot(chrome: unknown): Capture {
  return loadExtensionFunction<Capture>(DECLARATIONS, 'takeScreenshot', ['chrome'])(chrome)
}

/** A debugger target the extension does not own, i.e. DevTools. */
const DEVTOOLS_TARGET = [{ tabId: 7, attached: true, extensionId: 'devtools-extension' }]

interface Outcome {
  /** What `chrome.debugger.getTargets` reports. */
  targets?: Array<{ tabId: number; attached: boolean; extensionId?: string }>
  /** Makes `chrome.debugger.attach` fail with this message. */
  attachError?: string
  /** Whether the tab is active; the visible-tab call photographs the active one. */
  active?: boolean
  /** What `captureVisibleTab` resolves to; a non-`data:` value is broken. */
  image?: unknown
  /** Makes `captureVisibleTab` fail with this message. */
  captureError?: string
}

/** A `chrome` whose debugger and visible-window capture can be steered. */
function stub(outcome: Outcome = {}): { chrome: unknown; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    chrome: {
      runtime: { id: 'our-extension' },
      debugger: {
        getTargets: async () => outcome.targets ?? [],
        attach: async () => {
          calls.push('attach')
          if (outcome.attachError !== undefined) throw new Error(outcome.attachError)
        },
        detach: async () => { calls.push('detach') },
        sendCommand: async () => ({ data: 'DEBUGGER-JPEG' }),
      },
      tabs: {
        get: async (tabId: number) => {
          calls.push('tabs.get')
          return { id: tabId, active: outcome.active !== false, windowId: 9 }
        },
        captureVisibleTab: async (windowId: number, options: unknown) => {
          calls.push(`captureVisibleTab:${windowId}:${JSON.stringify(options)}`)
          if (outcome.captureError !== undefined) throw new Error(outcome.captureError)
          return outcome.image !== undefined ? outcome.image : 'data:image/jpeg;base64,VISIBLE-JPEG'
        },
      },
    },
  }
}

describe('takeScreenshot', () => {
  it('uses the debugger while nothing else holds it', async () => {
    const fixture = stub()
    await expect(takeScreenshot(fixture.chrome)(7)).resolves.toEqual({
      dataUrl: 'data:image/jpeg;base64,DEBUGGER-JPEG',
      fallback: false,
      viewportOnly: false,
    })
    expect(fixture.calls).toEqual(['attach', 'detach'])
  })

  it('captures the visible window when DevTools owns the debugger', async () => {
    const fixture = stub({ targets: DEVTOOLS_TARGET })
    await expect(takeScreenshot(fixture.chrome)(7)).resolves.toEqual({
      dataUrl: 'data:image/jpeg;base64,VISIBLE-JPEG',
      fallback: true,
      viewportOnly: false,
    })
    // The same JPEG quality as the debugger path, and the tab's own window.
    expect(fixture.calls).toEqual(['tabs.get', 'captureVisibleTab:9:{"format":"jpeg","quality":75}'])
  })

  it('falls back when DevTools attaches between the listing and the attach', async () => {
    // Chrome's own wording for the race: `getTargets` said free, `attach` did not.
    const fixture = stub({ attachError: 'Another debugger is already attached to the tab with id: 7.' })
    await expect(takeScreenshot(fixture.chrome)(7)).resolves.toMatchObject({ fallback: true })
    expect(fixture.calls).toContain('tabs.get')
  })

  it('marks a fullPage request the fallback cannot honour as viewport-only', async () => {
    const fixture = stub({ targets: DEVTOOLS_TARGET })
    await expect(takeScreenshot(fixture.chrome)(7, { fullPage: true })).resolves.toMatchObject({
      fallback: true,
      viewportOnly: true,
    })
  })

  it('marks a selector request the fallback cannot honour as viewport-only', async () => {
    const fixture = stub({ targets: DEVTOOLS_TARGET })
    await expect(takeScreenshot(fixture.chrome)(7, { selector: '#popup' })).resolves.toMatchObject({
      fallback: true,
      viewportOnly: true,
    })
  })

  it('does not fall back for a debugger failure that is not DevTools', async () => {
    const fixture = stub({ attachError: 'Cannot attach to this target' })
    await expect(takeScreenshot(fixture.chrome)(7)).rejects.toThrow(/Cannot attach/)
    expect(fixture.calls).not.toContain('tabs.get')
  })

  it('refuses to photograph whatever tab happens to be in front', async () => {
    // `captureVisibleTab` returns the ACTIVE tab of the window, so capturing a
    // background tab this way would silently return some other page.
    const fixture = stub({ targets: DEVTOOLS_TARGET, active: false })
    await expect(takeScreenshot(fixture.chrome)(7)).rejects.toThrow(/不在前台[^]*关闭 DevTools/)
    expect(fixture.calls).toEqual(['tabs.get'])
  })

  it('keeps the DevTools cause when the fallback itself fails', async () => {
    const fixture = stub({ targets: DEVTOOLS_TARGET, captureError: 'image readback failed' })
    await expect(takeScreenshot(fixture.chrome)(7)).rejects.toThrow(
      /该标签页被另一个调试器占用[^]*可视区域回退也失败:image readback failed/,
    )
  })

  it('treats a capture without image data as a failure', async () => {
    const fixture = stub({ targets: DEVTOOLS_TARGET, image: 'not-an-image' })
    await expect(takeScreenshot(fixture.chrome)(7)).rejects.toThrow(/没有返回图像数据/)
  })
})
