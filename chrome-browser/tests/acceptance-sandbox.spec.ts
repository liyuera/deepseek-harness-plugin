/**
 * Sandbox acceptance: drive a real, isolated owned Chrome through the
 * production `BackendRegistry` and prove per-agent isolation on a live page.
 *
 * Gated behind `DSH_CHROME_SMOKE=1` like the other real-browser smoke tests, so
 * the normal `pnpm test` suite never spawns Chrome. Uses a dedicated high port
 * and a temporary DSH_HOME profile dir; headless so no window appears.
 */
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { BackendRegistry } from '../src/backend-registry.ts'
import { CdpBackend } from '../src/backend.ts'
import type { BrowserBackend } from '../src/backend.ts'
import { Chrome, resolveChromeConfig } from '../src/chrome.ts'

const isSmoke = process.env.DSH_CHROME_SMOKE === '1'

/** The acceptance page served on loopback. */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>沙箱验收页</title>
<style>body{font-family:sans-serif;background:#0f172a;color:#e2e8f0;padding:40px}
h1{color:#34d399}.badge{display:inline-block;background:#34d399;color:#0f172a;padding:6px 14px;border-radius:8px;font-weight:700}</style>
</head><body>
<h1 id="heading">沙箱验收通过 ✅</h1>
<div class="badge">agent-A · isolated owned Chrome</div>
<p id="note">这个页面运行在独立 Chrome 实例里，与你正在使用的浏览器无关。</p>
<p id="agent">agent id: acc-a</p>
</body></html>`

/** A no-op shared backend; sandbox-mode agents never touch it. */
function fakeShared(): BrowserBackend {
  return {
    ensure: async () => {}, activeTabId: async () => 'x', listTabs: async () => [],
    openTab: async () => ({ id: 'x', title: '', url: '', active: true, favicon: '' }),
    closeTab: async () => {}, read: async () => ({ title: '', url: '', text: '', html: '' }),
    inventory: async () => ({ title: '', url: '', matched: 0, items: [] }),
    navigate: async () => {}, waitForLoad: async () => {}, evaluate: async () => undefined,
    lastEvalWorld: undefined, webmcpTools: async () => ({ available: false, tools: [] }),
    webmcpCall: async () => ({ tool: '' }),
    click: async () => ({ matched: 0, clicked: 0, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0 }),
    hover: async () => ({ matched: 0, hovered: false }),
    press: async () => ({ found: false, pressed: false, submitted: false }),
    select: async () => ({ matched: 0, changed: false, value: '', options: [] }),
    waitFor: async () => false, type: async () => {}, screenshot: async () => ({ data: '' }),
    startConsole: async () => {}, stopConsole: async () => {}, dispose() {},
  }
}

describe.skipIf(!isSmoke)('sandbox acceptance', () => {
  it('renders a test page in an isolated per-agent sandbox', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('server did not bind')
    const url = `http://127.0.0.1:${address.port}/`

    const config = resolveChromeConfig({
      backend: 'sandbox',
      port: 9431,
      sandboxMaxConcurrent: 2,
      sandboxIdleMs: 0,
      sandboxHeadless: process.env.DSH_CHROME_HEADFUL !== '1',
      timeoutMs: 20000,
    })
    const registry = new BackendRegistry(
      config,
      fakeShared(),
      sandbox => new CdpBackend(new Chrome(sandbox), () => {}),
    )

    try {
      const backendA = registry.resolve({ agent: { id: 'acc-a' } })
      const backendB = registry.resolve({ agent: { id: 'acc-b' } })
      expect(backendA).not.toBe(backendB)

      const tabA = await backendA.openTab(url)
      await backendA.waitForLoad(tabA.id, 20000)
      const page = await backendA.read(tabA.id, false)
      expect(page.title).toBe('沙箱验收页')
      expect(page.text).toContain('沙箱验收通过')

      const shot = await backendA.screenshot(tabA.id)
      expect(shot.mime).toBe('image/png')
      expect(shot.data.length).toBeGreaterThan(1000)
      const { writeFileSync: write } = await import('node:fs')
      write('/tmp/sandbox-accept.png', Buffer.from(shot.data, 'base64'))

      // Isolation: agent-B's own sandbox cannot see agent-A's tab.
      const tabsB = await backendB.listTabs()
      expect(tabsB.some(tab => tab.id === tabA.id)).toBe(false)

      // And agent-B can drive its own page independently.
      const tabB = await backendB.openTab(url)
      await backendB.waitForLoad(tabB.id, 20000)
      const pageB = await backendB.read(tabB.id, false)
      expect(pageB.title).toBe('沙箱验收页')

      if (process.env.DSH_CHROME_HEADFUL === '1') {
        // Keep both isolated windows on screen so a human can see them.
        await new Promise(resolve => setTimeout(resolve, 20_000))
      }
    } finally {
      registry.dispose()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 120_000)
})
