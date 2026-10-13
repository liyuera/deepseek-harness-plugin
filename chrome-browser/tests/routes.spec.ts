import { describe, expect, it } from 'vitest'
import type { ServerResponse } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { CdpBackend } from '../src/backend.ts'
import { SessionBindings } from '../src/bindings.ts'
import { Chrome, resolveChromeConfig } from '../src/chrome.ts'
import type { ChromeTab } from '../src/chrome.ts'
import { registerChromeRoutes } from '../src/routes.ts'

/** Fake HTTP carrier capturing registered routes. */
function fakeWebServer(): {
  register(route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
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

function fakeRes(): ServerResponse {
  const response = {
    status: 0,
    body: '',
    headers: {} as Record<string, string>,
    raw: undefined as unknown,
  } as ServerResponse & { status: number; body: string; headers: Record<string, string>; raw: unknown }
  response.writeHead = ((status: number, headers?: Record<string, string>) => {
    response.status = status
    response.headers = headers ?? {}
  }) as unknown as ServerResponse['writeHead']
  response.end = ((body?: unknown) => {
    response.raw = body
    response.body = body === undefined ? '' : String(body)
  }) as unknown as ServerResponse['end']
  return response
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
    const bindings = new SessionBindings()
    registerChromeRoutes(fakeCtx(server) as never, new CdpBackend(fakeChrome(TABS)), bindings)
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
    registerChromeRoutes(fakeCtx(server) as never, new CdpBackend(deadChrome()), new SessionBindings())
    const res = fakeRes()
    await (server.routes['/chrome-browser/tabs'] as (req: IncomingMessage, res: ServerResponse) => Promise<void>)(fakeReq('POST'), res)
    const body = JSON.parse(res.body) as { ok: boolean; error?: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('no Chrome DevTools endpoint')
  })

  it('binds a tab to the session (POST /chrome-browser/select)', async () => {
    const server = fakeWebServer()
    const bindings = new SessionBindings()
    registerChromeRoutes(fakeCtx(server) as never, new CdpBackend(fakeChrome(TABS)), bindings)
    const handler = server.routes['/chrome-browser/select'] as (req: IncomingMessage, res: ServerResponse) => Promise<void>
    const res = fakeRes()
    await handler(fakeReq('POST', undefined, { sessionId: 's0', tabId: 't2' }), res)
    const body = JSON.parse(res.body) as { ok: boolean; tab?: ChromeTab }
    expect(body.ok).toBe(true)
    expect(body.tab?.id).toBe('t2')
    expect(bindings.get('s0')).toBe('t2')
  })

  it('binds a multi-selection (POST tabIds) and reports every picked tab', async () => {
    const server = fakeWebServer()
    const bindings = new SessionBindings()
    registerChromeRoutes(fakeCtx(server) as never, new CdpBackend(fakeChrome(TABS)), bindings)
    const handler = server.routes['/chrome-browser/select'] as (req: IncomingMessage, res: ServerResponse) => Promise<void>
    const res = fakeRes()
    await handler(fakeReq('POST', undefined, { sessionId: 's0', tabIds: ['t2', 't1'] }), res)
    const body = JSON.parse(res.body) as { ok: boolean; tab?: ChromeTab; tabs?: ChromeTab[] }
    expect(body.ok).toBe(true)
    expect(body.tab?.id).toBe('t2')
    expect(body.tabs?.map(tab => tab.id)).toEqual(['t2', 't1'])
    expect(bindings.all('s0')).toEqual(['t2', 't1'])
  })

  it('rejects a malformed select body', async () => {
    const server = fakeWebServer()
    registerChromeRoutes(fakeCtx(server) as never, new CdpBackend(fakeChrome(TABS)), new SessionBindings())
    const handler = server.routes['/chrome-browser/select'] as (req: IncomingMessage, res: ServerResponse) => Promise<void>
    const res = fakeRes()
    await handler(fakeReq('POST', undefined, { sessionId: 's0' }), res)
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body) as { ok: boolean }).toMatchObject({ ok: false })
  })

  it('rejects an unknown tab id', async () => {
    const server = fakeWebServer()
    registerChromeRoutes(fakeCtx(server) as never, new CdpBackend(fakeChrome(TABS)), new SessionBindings())
    const handler = server.routes['/chrome-browser/select'] as (req: IncomingMessage, res: ServerResponse) => Promise<void>
    const res = fakeRes()
    await handler(fakeReq('POST', undefined, { sessionId: 's0', tabId: 'nope' }), res)
    const body = JSON.parse(res.body) as { ok: boolean; error?: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('not found')
  })

  it('reports the current binding (GET /chrome-browser/state)', async () => {
    const server = fakeWebServer()
    const bindings = new SessionBindings()
    registerChromeRoutes(fakeCtx(server) as never, new CdpBackend(fakeChrome(TABS)), bindings)
    const handler = server.routes['/chrome-browser/state'] as (req: IncomingMessage, res: ServerResponse) => Promise<void>
    const emptyRes = fakeRes()
    await handler(fakeReq('GET', '/chrome-browser/state?sessionId=s0'), emptyRes)
    expect((JSON.parse(emptyRes.body) as { selected: unknown }).selected).toBeNull()

    bindings.set('s0', ['t1'])
    const boundRes = fakeRes()
    await handler(fakeReq('GET', '/chrome-browser/state?sessionId=s0'), boundRes)
    const body = JSON.parse(boundRes.body) as { selected: { tabId: string; title: string } | null }
    expect(body.selected).toMatchObject({ tabId: 't1', title: 'One' })
  })

  it('hands out the bundled extension as a zip (GET /chrome-browser/extension.zip)', async () => {
    const server = fakeWebServer()
    registerChromeRoutes(fakeCtx(server) as never, new CdpBackend(fakeChrome(TABS)), new SessionBindings())
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
    registerChromeRoutes(fakeCtx(server) as never, new CdpBackend(fakeChrome(TABS)), new SessionBindings())
    const handler = server.routes['/chrome-browser/extension.zip'] as (req: IncomingMessage, res: ServerResponse) => void
    const res = fakeRes()
    handler(fakeReq('POST', '/chrome-browser/extension.zip'), res)
    expect(res.status).toBe(405)
    expect(JSON.parse(res.body) as { ok: boolean }).toMatchObject({ ok: false })
  })
})
