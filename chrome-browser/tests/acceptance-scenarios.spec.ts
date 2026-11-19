/**
 * Real-scenario acceptance for per-call backend selection, gated behind
 * `DSH_CHROME_SMOKE=1`. Drives the production `BackendRegistry` with real
 * owned Chrome instances and writes screenshots for each scenario:
 *   1. three agents run isolated sandboxes concurrently,
 *   2. sandbox first, then `backend:'user'` (the shared browser),
 *   3. direct `backend:'user'`.
 *
 * The `shared` backend is a real owned Chrome standing in for the extension
 * backend (the extension is not installed in this test environment), so the
 * routing `resolve(..., 'user') -> shared` is exercised against a driveable
 * browser without touching the user's own Chrome.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { BackendRegistry } from '../src/backend-registry.ts'
import { CdpBackend } from '../src/backend.ts'
import type { BrowserBackend } from '../src/backend.ts'
import { Chrome, resolveChromeConfig } from '../src/chrome.ts'

const isSmoke = process.env.DSH_CHROME_SMOKE === '1'

const page = (label: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>场景验收</title>
<style>body{font-family:sans-serif;background:#111827;color:#f9fafb;padding:40px}
h1{color:#34d399}.tag{display:inline-block;background:#34d399;color:#111827;padding:6px 14px;border-radius:8px;font-weight:700}</style>
</head><body><h1>${label}</h1><div class="tag">isolated owned Chrome</div>
<p>这个页面由一个独立的 sandbox/user 浏览器渲染。</p></body></html>`

async function startServer(label: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page(label))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('server did not bind')
  return { url: `http://127.0.0.1:${address.port}/`, close: () => new Promise<void>(r => server.close(() => r())) }
}

async function shoot(backend: BrowserBackend, tabId: string, path: string): Promise<number> {
  const shot = await backend.screenshot(tabId)
  if (shot.data === '') throw new Error(`empty screenshot for ${path}`)
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
  return Buffer.byteLength(shot.data, 'base64')
}

function sandboxRegistry(basePort: number, sharedPort: number, maxConcurrent = 4): BackendRegistry {
  const sandboxCfg = resolveChromeConfig({
    backend: 'sandbox', port: basePort, sandboxMaxConcurrent: maxConcurrent,
    sandboxIdleMs: 0, sandboxHeadless: true, timeoutMs: 20000,
  })
  const sharedCfg = resolveChromeConfig({
    backend: 'cdp', port: sharedPort, mode: 'owned', sandboxHeadless: true, timeoutMs: 20000,
    profileDir: mkdtempSync(join(tmpdir(), `scenario-shared-${sharedPort}-`)),
  })
  const shared = new CdpBackend(new Chrome(sharedCfg), () => {})
  return new BackendRegistry(sandboxCfg, shared, config => new CdpBackend(new Chrome(config), () => {}))
}

describe.skipIf(!isSmoke)('per-call backend scenarios', () => {
  it('scenario 1: three agents run isolated sandboxes concurrently', async () => {
    const server = await startServer('多 agent 并行沙箱')
    const registry = sandboxRegistry(9450, 9440)
    try {
      const agents = ['sc-a', 'sc-b', 'sc-c']
      const results = await Promise.all(agents.map(async (id) => {
        const backend = registry.resolve({ agent: { id } })
        const tab = await backend.openTab(server.url)
        await backend.waitForLoad(tab.id, 20000)
        const read = await backend.read(tab.id, false)
        const bytes = await shoot(backend, tab.id, `/tmp/scenario1-${id}.png`)
        return { id, backend, tab, read, bytes }
      }))
      expect(new Set(results.map(r => r.backend)).size).toBe(3)
      for (const result of results) {
        expect(result.read.title).toBe('场景验收')
        expect(result.read.text).toContain('多 agent 并行沙箱')
        expect(result.bytes).toBeGreaterThan(1000)
        for (const other of results) {
          if (other === result) continue
          const tabs = await result.backend.listTabs()
          expect(tabs.some(tab => tab.id === other.tab.id)).toBe(false)
        }
      }
    } finally {
      registry.dispose()
      await server.close()
    }
  }, 120_000)

  it('scenario 2: sandbox first, then backend user (fallback)', async () => {
    const server = await startServer('沙箱优先 → user 备选')
    const registry = sandboxRegistry(9460, 9441, 2)
    try {
      const agent = { agent: { id: 'sc-2' } }
      const sandbox = registry.resolve(agent)
      expect(sandbox).not.toBe(registry.resolve(agent, 'user'))
      const sandboxTab = await sandbox.openTab(server.url)
      await sandbox.waitForLoad(sandboxTab.id, 20000)
      expect((await sandbox.read(sandboxTab.id, false)).text).toContain('沙箱优先 → user 备选')
      await shoot(sandbox, sandboxTab.id, '/tmp/scenario2-sandbox.png')

      const user = registry.resolve(agent, 'user')
      const userTab = await user.openTab(server.url)
      await user.waitForLoad(userTab.id, 20000)
      expect((await user.read(userTab.id, false)).text).toContain('沙箱优先 → user 备选')
      await shoot(user, userTab.id, '/tmp/scenario2-user.png')
      expect((await user.listTabs()).some(tab => tab.id === sandboxTab.id)).toBe(false)
    } finally {
      registry.dispose()
      await server.close()
    }
  }, 120_000)

  it('scenario 3: direct backend user', async () => {
    const server = await startServer('直接 user')
    const registry = sandboxRegistry(9470, 9442)
    try {
      const backend = registry.resolve({ agent: { id: 'sc-3' } }, 'user')
      const tab = await backend.openTab(server.url)
      await backend.waitForLoad(tab.id, 20000)
      expect((await backend.read(tab.id, false)).text).toContain('直接 user')
      const bytes = await shoot(backend, tab.id, '/tmp/scenario3-user.png')
      expect(bytes).toBeGreaterThan(1000)
    } finally {
      registry.dispose()
      await server.close()
    }
  }, 120_000)
})
