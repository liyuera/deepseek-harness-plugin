import { describe, expect, it } from 'vitest'
import type { ServerResponse } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpBackend } from '../src/backend.ts'
import { Chrome, resolveChromeConfig } from '../src/chrome.ts'
import type { ChromeTab } from '../src/chrome.ts'
import { ActivityTracker } from '../src/activity.ts'
import { registerChromeRoutes } from '../src/routes.ts'

/** One fake response, plus what the assertions read back off it. */
interface FakeResponse extends ServerResponse {
  status: number
  body: string
  headers: Record<string, string>
  raw: unknown
}

/** Screenshot directory the routes take; no test writes into it. */
const SHOTS = join(tmpdir(), 'dsh-chrome-routes-shots')

/** Fake HTTP carrier capturing registered routes. */
function fakeWebServer(): {
  register(route: {
    kind?: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
  registerUpgrade(route: { path: string; handler: unknown }): () => void
  routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>
} {
  const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>> = {}
  return {
    routes,
    register(route) {
      routes[route.path] = route.handler
      return () => { delete routes[route.path] }
    },
    registerUpgrade() {
      return () => {}
    },
  }
}

function fakeCtx(webServer: unknown): { get(name: string): unknown; effect(callback: () => () => void): void } {
  return {
    get: () => webServer,
    effect: (callback) => {
      callback()
    },
  }
}

function fakeRes(): FakeResponse {
  const response = {
    status: 0,
    body: '',
    headers: {} as Record<string, string>,
    raw: undefined as unknown,
    writeHead: (status: number, headers?: Record<string, string>) => {
      response.status = status
      response.headers = headers ?? {}
      return response
    },
    end: (body?: unknown) => {
      response.raw = body
      response.body = body === undefined ? '' : String(body)
      return response
    },
  }
  return response as unknown as FakeResponse
}

function fakeReq(method: string, url?: string, body?: unknown): IncomingMessage {
  const message = { method, url } as IncomingMessage
  const payload = Buffer.from(JSON.stringify(body ?? {}))
  Object.defineProperty(message, Symbol.asyncIterator, {
    value: () => {
      let delivered = false
      return {
        next: async () => {
          if (delivered) return { done: true, value: undefined }
          delivered = true
          return { done: false, value: payload }
        },
      }
    },
  })
  return message
}

/** Chrome whose fake HTTP carrier answers version + a fixed tab list. */
function fakeChrome(tabs: ReadonlyArray<Record<string, unknown>>): Chrome {
  const httpFetch = async (url: string): Promise<{ ok: boolean; json: () => Promise<unknown> }> => {
    if (url.includes('/json/version')) return { ok: true, json: async () => ({ browser: 'Chrome Headless' }) }
    if (url.includes('/json/list')) return { ok: true, json: async () => tabs }
    throw new Error(`unexpected fetch ${url}`)
  }
  return new Chrome(
    resolveChromeConfig({ port: 59341, attachOnly: true, timeoutMs: 200 }),
    { httpFetch: httpFetch as unknown as typeof fetch },
  )
}

/** Chrome whose fake HTTP carrier always refuses. */
function deadChrome(): Chrome {
  return new Chrome(
    resolveChromeConfig({ port: 59342, attachOnly: true, timeoutMs: 200 }),
    { httpFetch: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch },
  )
}

const TABS: ReadonlyArray<Record<string, unknown>> = [
  { id: 't1', type: 'page', title: 'One', url: 'https://one.example', active: true, webSocketDebuggerUrl: 'ws://t1' },
  { id: 't2', type: 'page', title: 'Two', url: 'https://two.example', active: false, webSocketDebuggerUrl: 'ws://t2' },
]

describe('chrome-browser routes', () => {
  it('lists tabs (POST /chrome-browser/tabs)', async () => {
    const server = fakeWebServer()
    registerChromeRoutes(fakeCtx(server) as never, new CdpBackend(fakeChrome(TABS)), SHOTS, new ActivityTracker())
    const res = fakeRes()
    await (server.routes['/chrome-browser/tabs'] as (req: IncomingMessage, res: ServerResponse) => Promise<void>)(fakeReq('POST'), res)
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { ok: boolean; tabs?: Array<ChromeTab & { favicon?: string }> }
    expect(body.ok).toBe(true)
    expect(body.tabs).toHaveLength(2)
    expect(body.tabs?.[0]).toMatchObject({ id: 't1', title: 'One' })
    expect(body.tabs?.[0]?.favicon).toBe('https://one.example/favicon.ico')
  })

  it('reports an ok:false error when the browser cannot be reached', async () => {
    const server = fakeWebServer()
    registerChromeRoutes(fakeCtx(server) as never, new CdpBackend(deadChrome()), SHOTS, new ActivityTracker())
    const res = fakeRes()
    await (server.routes['/chrome-browser/tabs'] as (req: IncomingMessage, res: ServerResponse) => Promise<void>)(fakeReq('POST'), res)
    const body = JSON.parse(res.body) as { ok: boolean; error?: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('no Chrome DevTools endpoint')
  })

  it('hands out the bundled extension as a zip (GET /chrome-browser/extension.zip)', async () => {
    const server = fakeWebServer()
    registerChromeRoutes(fakeCtx(server) as never, new CdpBackend(fakeChrome(TABS)), SHOTS, new ActivityTracker())
    const handler = server.routes['/chrome-browser/extension.zip'] as (req: IncomingMessage, res: ServerResponse) => void
    const res = fakeRes()
    handler(fakeReq('GET', '/chrome-browser/extension.zip'), res)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/zip')
    expect(res.headers['content-disposition']).toContain('dsh-chrome-browser-extension.zip')
    const archive = res.raw as Buffer
    expect(archive.subarray(0, 4).toString('binary')).toBe('PK\u0003\u0004')
    expect(archive.includes(Buffer.from('dsh-chrome-browser-extension/manifest.json'))).toBe(true)
    expect(archive.includes(Buffer.from('dsh-chrome-browser-extension/service-worker.js'))).toBe(true)
  })

  it('rejects a non-GET request for the extension zip', async () => {
    const server = fakeWebServer()
    registerChromeRoutes(fakeCtx(server) as never, new CdpBackend(fakeChrome(TABS)), SHOTS, new ActivityTracker())
    const handler = server.routes['/chrome-browser/extension.zip'] as (req: IncomingMessage, res: ServerResponse) => void
    const res = fakeRes()
    handler(fakeReq('POST', '/chrome-browser/extension.zip'), res)
    expect(res.status).toBe(405)
    expect(JSON.parse(res.body) as { ok: boolean }).toMatchObject({ ok: false })
  })

  it('reports whether a session has a browser call in flight', async () => {
    const server = fakeWebServer()
    const activity = new ActivityTracker()
    registerChromeRoutes(
      fakeCtx(server) as never,
      new CdpBackend(fakeChrome(TABS)),
      join(tmpdir(), 'dsh-chrome-routes-shots'),
      activity,
    )
    const handler = server.routes['/chrome-browser/activity'] as (req: IncomingMessage, res: ServerResponse) => void

    const idle = fakeRes()
    handler(fakeReq('GET', '/chrome-browser/activity?sessionId=s1'), idle)
    expect(JSON.parse(idle.body) as unknown).toMatchObject({ ok: true, active: false })

    activity.begin('chrome_click', '7', 's1')
    const busy = fakeRes()
    handler(fakeReq('GET', '/chrome-browser/activity?sessionId=s1'), busy)
    expect(JSON.parse(busy.body) as unknown)
      .toMatchObject({ ok: true, active: true, tool: 'chrome_click', tabId: '7' })

    const other = fakeRes()
    handler(fakeReq('GET', '/chrome-browser/activity?sessionId=s2'), other)
    expect(JSON.parse(other.body) as unknown).toMatchObject({ ok: true, active: false })
  })

  it('rejects a non-GET request for the activity route', async () => {
    const server = fakeWebServer()
    registerChromeRoutes(fakeCtx(server) as never, new CdpBackend(fakeChrome(TABS)), SHOTS, new ActivityTracker())
    const handler = server.routes['/chrome-browser/activity'] as (req: IncomingMessage, res: ServerResponse) => void
    const res = fakeRes()
    handler(fakeReq('POST', '/chrome-browser/activity'), res)
    expect(res.status).toBe(405)
  })
})
