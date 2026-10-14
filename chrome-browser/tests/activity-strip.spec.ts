// @vitest-environment jsdom
/**
 * The activity strip's browser half, rendered.
 *
 * The host half is verified against a live browser: `/chrome-browser/activity`
 * reports `active: true` with the tool and tab for the duration of a real call,
 * and `false` either side of it. What that cannot show is whether anything is
 * drawn from it, and the strip is deliberately invisible whenever it is idle —
 * so a screenshot of a quiet composer looks the same whether the component
 * works or was never mounted at all.
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

/** Mount the strip for one session and return its host element. */
async function mount(sessionId = 's1'): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(BrowserActivity, { sessionId }))
  })
  return host
}

/** Let the strip's first probe resolve and re-render. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  resetChromeActivityCache()
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BrowserActivity', () => {
  it('draws nothing while the plugin is idle', async () => {
    answerWith({ ok: true, active: false })
    const host = await mount()
    await settle()
    expect(host.textContent).toBe('')
  })

  it('names the tool and the tab while a call is in flight', async () => {
    answerWith({ ok: true, active: true, tool: 'chrome_click', tabId: '1178519964' })
    const host = await mount()
    await settle()
    expect(host.textContent).toContain('点击')
    expect(host.textContent).toContain('标签页 1178519964')
  })

  it('labels the human-help wait in the user\'s terms', async () => {
    answerWith({ ok: true, active: true, tool: 'chrome_request_help' })
    const host = await mount()
    await settle()
    expect(host.textContent).toContain('等待你操作')
  })

  it('falls back to the wire name for a tool it has no label for', async () => {
    answerWith({ ok: true, active: true, tool: 'chrome_future_thing' })
    const host = await mount()
    await settle()
    expect(host.textContent).toContain('chrome_future_thing')
  })

  it('omits the tab when the call named none', async () => {
    answerWith({ ok: true, active: true, tool: 'chrome_tabs' })
    const host = await mount()
    await settle()
    expect(host.textContent).toContain('列出标签页')
    expect(host.textContent).not.toContain('标签页 ')
  })

  it('stays hidden when the host cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const host = await mount()
    await settle()
    expect(host.textContent).toBe('')
  })

  it('asks the host about the session it was given', async () => {
    answerWith({ ok: true, active: false })
    await mount('session-42')
    await settle()
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain('sessionId=session-42')
  })

  it('announces itself to assistive technology only while visible', async () => {
    answerWith({ ok: true, active: true, tool: 'chrome_read' })
    const host = await mount()
    await settle()
    expect(host.querySelector('[role="status"]')).not.toBeNull()
    expect(host.querySelector('[aria-live="polite"]')).not.toBeNull()
  })

  it('is gone again once a later probe reports idle', async () => {
    answerWith({ ok: true, active: true, tool: 'chrome_read' })
    const host = await mount()
    await settle()
    expect(host.textContent).toContain('读取页面')
    resetChromeActivityCache()
    answerWith({ ok: true, active: false })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)) })
    await settle()
    expect(host.textContent).toBe('')
  })
})
