// @vitest-environment jsdom
/**
 * The status chip's browser half, rendered.
 *
 * The host half is verified against a live browser: `/chrome-browser/activity`
 * reports the phase, the tool and the tab across a real call. What that cannot
 * show is whether anything is drawn from it — and the chip is **always**
 * mounted, so the states that matter are the ones that must be legible at a
 * glance rather than the ones that appear.
 *
 * `react-dom` is driven directly rather than through a testing library: a
 * library resolves its own React from the workspace, and two copies make every
 * hook read a null dispatcher.
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserActivity } from '../src/client/BrowserActivity.tsx'
import { resetChromeActivityCache } from '../src/client/activity.ts'

/** Answer every probe with one payload. */
function answerWith(payload: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => payload })))
}

/** Mount the chip for one session and return its host element. */
async function mount(sessionId = 's1'): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(BrowserActivity, { sessionId }))
  })
  return host
}

/** Let the chip's first probe resolve and re-render. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

/** The phase the chip currently declares. */
function phaseOf(host: HTMLElement): string | null {
  return host.querySelector('.cb-status')?.getAttribute('data-phase') ?? null
}

beforeEach(() => {
  resetChromeActivityCache()
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BrowserActivity', () => {
  it('stays on screen when the plugin is idle', async () => {
    // The whole point of moving it into the header: an indicator that appears
    // only while a call runs is unreadable, because those calls finish in
    // milliseconds and it reads as a flicker.
    answerWith({ ok: true, connected: true, stale: false, phase: 'ready' })
    const host = await mount()
    await settle()
    expect(phaseOf(host)).toBe('ready')
    expect(host.textContent).toContain('Chrome 就绪')
  })

  it('names the tool and the tab while a call is in flight', async () => {
    answerWith({ ok: true, connected: true, stale: false, phase: 'running', tool: 'chrome_click', tabId: '7' })
    const host = await mount()
    await settle()
    expect(phaseOf(host)).toBe('running')
    expect(host.textContent).toContain('点击')
    expect(host.textContent).toContain('标签页 7')
  })

  it('says the call finished', async () => {
    answerWith({ ok: true, connected: true, stale: false, phase: 'done', tool: 'chrome_read' })
    const host = await mount()
    await settle()
    expect(phaseOf(host)).toBe('done')
    expect(host.textContent).toContain('完成')
  })

  it('shows a failure and the reason on hover', async () => {
    answerWith({
      ok: true,
      connected: true,
      stale: false,
      phase: 'error',
      tool: 'chrome_click',
      detail: 'no element matched selector "#x"',
    })
    const host = await mount()
    await settle()
    expect(phaseOf(host)).toBe('error')
    expect(host.textContent).toContain('失败')
    expect(host.querySelector('.cb-status')?.getAttribute('title')).toContain('no element matched selector "#x"')
  })

  it('labels the human-help wait in the user\'s terms', async () => {
    answerWith({ ok: true, connected: true, stale: false, phase: 'running', tool: 'chrome_request_help' })
    const host = await mount()
    await settle()
    expect(host.textContent).toContain('等待你操作')
  })

  it('falls back to the wire name for a tool it has no label for', async () => {
    answerWith({ ok: true, connected: true, stale: false, phase: 'running', tool: 'chrome_future_thing' })
    const host = await mount()
    await settle()
    expect(host.textContent).toContain('chrome_future_thing')
  })

  it('omits the tab when the call named none', async () => {
    answerWith({ ok: true, connected: true, stale: false, phase: 'running', tool: 'chrome_tabs' })
    const host = await mount()
    await settle()
    expect(host.textContent).toContain('列出标签页')
    expect(host.textContent).not.toContain('标签页 undefined')
  })

  it('says so when the bridge is not attached, outranking the last call', async () => {
    // A `done` flash drawn on top of a disconnected bridge would misreport the
    // one state the user can act on.
    answerWith({ ok: true, connected: false, stale: false, phase: 'done', tool: 'chrome_read' })
    const host = await mount()
    await settle()
    expect(phaseOf(host)).toBe('offline')
    expect(host.textContent).toContain('Chrome 未连接')
  })

  it('says so when the extension is running older files', async () => {
    answerWith({ ok: true, connected: true, stale: true, phase: 'ready' })
    const host = await mount()
    await settle()
    expect(phaseOf(host)).toBe('stale')
    expect(host.textContent).toContain('扩展待更新')
  })

  it('reports the bridge missing when the host cannot be reached at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const host = await mount()
    await settle()
    expect(phaseOf(host)).toBe('offline')
  })

  it('asks the host about the session it was given', async () => {
    answerWith({ ok: true, connected: true, stale: false, phase: 'ready' })
    await mount('session-42')
    await settle()
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain('sessionId=session-42')
  })

  it('announces itself to assistive technology', async () => {
    answerWith({ ok: true, connected: true, stale: false, phase: 'running', tool: 'chrome_click', tabId: '7' })
    const host = await mount()
    await settle()
    const status = host.querySelector('.cb-status')
    expect(status?.getAttribute('role')).toBe('status')
    expect(status?.getAttribute('aria-live')).toBe('polite')
  })

  it('sizes its own artwork inline, so a missing stylesheet cannot blow it up', async () => {
    // The chip carries this plugin's 512px icon. When its sizes lived in an
    // injected rule set and that rule set did not apply, the header rendered
    // the raw 512px image — measured in a live window, not imagined.
    answerWith({ ok: true, connected: true, stale: false, phase: 'ready' })
    const host = await mount()
    await settle()
    const icon = host.querySelector('img') as HTMLImageElement | null
    expect(icon).not.toBeNull()
    expect(icon?.style.width).toBe('13px')
    expect(icon?.style.height).toBe('13px')
    const chip = host.querySelector('.cb-status') as HTMLElement | null
    expect(chip?.style.maxHeight).toBe('22px')
    expect(chip?.style.fontSize).toBe('12px')
  })

  it('follows a later probe into another phase', async () => {
    answerWith({ ok: true, connected: true, stale: false, phase: 'running', tool: 'chrome_click', tabId: '7' })
    const host = await mount()
    await settle()
    expect(phaseOf(host)).toBe('running')

    answerWith({ ok: true, connected: true, stale: false, phase: 'ready' })
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 1100) }) })
    await settle()
    expect(phaseOf(host)).toBe('ready')
  })
})
