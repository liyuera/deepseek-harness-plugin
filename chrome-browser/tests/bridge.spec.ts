/**
 * The fixed-port bridge decision: the dsh web server is the bridge when it
 * already listens on the extension's port, otherwise the plugin owns the port
 * itself, and a port another process owns is reported instead of thrown.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExtensionBackend } from '../src/backend.ts'
import { installExtensionBridge } from '../src/bridge.ts'
import { BridgeServer } from '../src/local-server.ts'
import { DEFAULT_BRIDGE_PORT, resolveChromeConfig } from '../src/chrome.ts'

/** Screenshot directory the routes take; no test writes into it. */
const SHOTS = join(tmpdir(), 'dsh-chrome-bridge-shots')

/** Context face `installExtensionBridge` uses: the webServer port and effect cleanup. */
function fakeCtx(webServerPort: number | undefined): {
  ctx: unknown
  dispose(): Promise<void>
} {
  const disposers: Array<() => void> = []
  return {
    ctx: {
      get: (name: string) => (name === 'webServer' ? { port: webServerPort } : undefined),
      effect: (callback: () => () => void) => {
        disposers.push(callback())
      },
    },
    async dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose()
      // `close()` drops the listener on the next tick; give it one.
      await new Promise(resolve => setTimeout(resolve, 20))
    },
  }
}

/** Backend with no extension attached: routes must answer, tools cannot. */
function backend(): ExtensionBackend {
  return new ExtensionBackend(resolveChromeConfig({}))
}

/** Poll until the predicate holds or the bound elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the bridge')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const running: Array<{ dispose(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(entry => entry.dispose()))
})

describe('installExtensionBridge', () => {
  it('leaves the port to the dsh web server when it already listens there', async () => {
    const fake = fakeCtx(DEFAULT_BRIDGE_PORT)
    running.push(fake)
    const report = installExtensionBridge(fake.ctx as never, backend(), SHOTS, DEFAULT_BRIDGE_PORT)
    expect(report).toEqual({ port: DEFAULT_BRIDGE_PORT, carrier: 'webServer', listening: true })
  })

  it('serves the extension routes on its own port when dsh listens elsewhere', async () => {
    const fake = fakeCtx(3080)
    running.push(fake)
    const report = installExtensionBridge(fake.ctx as never, backend(), SHOTS, 0)
    expect(report.carrier).toBe('plugin')
    expect(report.listening).toBe(false)
    await waitFor(() => report.listening)
    expect(report.port).toBeGreaterThan(0)

    const response = await fetch(`http://127.0.0.1:${report.port}/chrome-browser/ext/status`)
    expect(response.status).toBe(200)
    expect(await response.json() as unknown).toMatchObject({
      ok: true,
      backend: 'extension',
      connected: false,
      bridge: { port: report.port, carrier: 'plugin', listening: true },
    })
  })

  it('reports a port another process owns instead of failing the page', async () => {
    const owner = new BridgeServer()
    const ownerPort = await owner.listen(0)
    running.push({ dispose: () => owner.close() })
    const fake = fakeCtx(3080)
    running.push(fake)

    const report = installExtensionBridge(fake.ctx as never, backend(), SHOTS, ownerPort)
    await waitFor(() => report.error !== undefined)
    expect(report.carrier).toBe('plugin')
    expect(report.listening).toBe(false)
    expect(report.error).toContain('EADDRINUSE')
  })

  it('stops answering the bridge port when the plugin unloads', async () => {
    const fake = fakeCtx(3080)
    const report = installExtensionBridge(fake.ctx as never, backend(), SHOTS, 0)
    await waitFor(() => report.listening)
    const port = report.port
    await expect(fetch(`http://127.0.0.1:${port}/chrome-browser/ext/status`)).resolves.toMatchObject({ status: 200 })
    await fake.dispose()
    await expect(fetch(`http://127.0.0.1:${port}/chrome-browser/ext/status`)).rejects.toThrow()
  })
})
