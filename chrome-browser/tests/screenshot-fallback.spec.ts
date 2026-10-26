/**
 * Screenshot degradation: when the debugger capture fails, take the window.
 *
 * `chrome.debugger` is the precise route — whole page, one element, background
 * tabs, no stale frames — but it can be unavailable: DevTools owns the tab,
 * a page refuses to render, or a clip cannot be measured. A screenshot is
 * evidence, so the extension then captures the window's visible tab instead of
 * returning nothing. That image is viewport-only, can be a stale frame, and
 * cannot honour `fullPage` / `selector` — so the answer carries `fallback`,
 * `viewportOnly` and the failure that caused it. A viewport silently standing in
 * for a whole page is the failure this plugin elsewhere refuses to ship.
 */
import { describe, expect, it } from 'vitest'
import { loadExtensionFunction } from './support/extension-source.ts'

/** One fallback-aware capture, as `takeScreenshot` returns it. */
type Capture = (tabId: number, options?: { fullPage?: boolean; selector?: string }) => Promise<{
  dataUrl: string
  fallback: boolean
  viewportOnly: boolean
  reason?: string
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

/** How DevTools' takeover is reported by the extension's own refusal. */
const DEVTOOLS_REASON = 'DevTools 占用了该标签页的调试通道'

interface Outcome {
  /** What `chrome.debugger.getTargets` reports. */
  targets?: Array<{ tabId: number; attached: boolean; extensionId?: string }>
  /** Makes `chrome.debugger.attach` fail with this message. */
  attachError?: string
  /** Makes the capture command fail after a successful attach. */
  captureCommandError?: string
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
        sendCommand: async () => {
          calls.push('Page.captureScreenshot')
          if (outcome.captureCommandError !== undefined) throw new Error(outcome.captureCommandError)
          return { data: 'DEBUGGER-JPEG' }
        },
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
    expect(fixture.calls).toEqual(['attach', 'Page.captureScreenshot', 'detach'])
  })

  it('captures the visible window when DevTools owns the debugger', async () => {
    const fixture = stub({ targets: DEVTOOLS_TARGET })
    await expect(takeScreenshot(fixture.chrome)(7)).resolves.toEqual({
      dataUrl: 'data:image/jpeg;base64,VISIBLE-JPEG',
      fallback: true,
      viewportOnly: false,
      reason: DEVTOOLS_REASON,
    })
    // The same JPEG quality as the debugger path, and the tab's own window.
    expect(fixture.calls).toEqual(['tabs.get', 'captureVisibleTab:9:{"format":"jpeg","quality":75}'])
  })

  it('names DevTools when it attaches between the listing and the attach', async () => {
    // Chrome's own wording for the race: `getTargets` said free, `attach` did not.
    const fixture = stub({ attachError: 'Another debugger is already attached to the tab with id: 7.' })
    await expect(takeScreenshot(fixture.chrome)(7)).resolves.toMatchObject({
      fallback: true,
      reason: DEVTOOLS_REASON,
    })
    expect(fixture.calls).toContain('tabs.get')
  })

  it('degrades on a capture failure that is not about DevTools', async () => {
    // A page Chrome refuses to render, an over-tall clip, a GPU limit: the
    // precise route is gone, but the window still has pixels worth returning.
    const fixture = stub({ captureCommandError: 'Unable to capture screenshot' })
    await expect(takeScreenshot(fixture.chrome)(7)).resolves.toMatchObject({
      fallback: true,
      viewportOnly: false,
      reason: 'Unable to capture screenshot',
    })
    expect(fixture.calls).toContain('tabs.get')
  })

  it('degrades on an attach failure that is not about DevTools', async () => {
    const fixture = stub({ attachError: 'Cannot attach to this target' })
    await expect(takeScreenshot(fixture.chrome)(7)).resolves.toMatchObject({
      fallback: true,
      reason: 'Cannot attach to this target',
    })
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

  it('refuses to photograph whatever tab happens to be in front', async () => {
    // `captureVisibleTab` returns the ACTIVE tab of the window, so capturing a
    // background tab this way would silently return some other page.
    const fixture = stub({ targets: DEVTOOLS_TARGET, active: false })
    await expect(takeScreenshot(fixture.chrome)(7)).rejects.toThrow(/可视区域回退:该标签页不在前台/)
    expect(fixture.calls).toEqual(['tabs.get'])
  })

  it('reports both causes when the fallback fails too', async () => {
    // Closing DevTools or bringing the window forward fixes one of them; the
    // caller should be able to tell which.
    const fixture = stub({ targets: DEVTOOLS_TARGET, captureError: 'image readback failed' })
    await expect(takeScreenshot(fixture.chrome)(7)).rejects.toThrow(
      /截图失败\(调试通道:该标签页已被另一个调试器占用[^]*可视区域回退:image readback failed\)/,
    )
  })

  it('treats a capture without image data as a failure', async () => {
    const fixture = stub({ targets: DEVTOOLS_TARGET, image: 'not-an-image' })
    await expect(takeScreenshot(fixture.chrome)(7)).rejects.toThrow(
      /可视区域回退:截图失败:可视区域通道没有返回图像数据/,
    )
  })

  it('rejects a tab id that is not a number before capturing anything', async () => {
    const fixture = stub()
    await expect(takeScreenshot(fixture.chrome)(Number('nope'))).rejects.toThrow(/无效的标签页 id/)
    expect(fixture.calls).toEqual([])
  })
})
