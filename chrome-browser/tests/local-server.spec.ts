/**
 * The plugin's own loopback bridge carrier: exact-path HTTP routing, the
 * WebSocket upgrade, lifecycle, and the failure a user actually hits — the port
 * already owned by another process.
 *
 * These tests bind real sockets (port 0) rather than stubbing `node:http`: the
 * carrier IS the socket plumbing, and a fake would assert only that the fake
 * was called.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { BridgeServer } from '../src/local-server.ts'
import { wsHandshake, WsConnection } from '../src/ws.ts'

const running: BridgeServer[] = []

async function start(): Promise<{ server: BridgeServer; port: number }> {
  const server = new BridgeServer()
  running.push(server)
  const port = await server.listen(0)
  return { server, port }
}

afterEach(async () => {
  await Promise.all(running.splice(0).map(server => server.close()))
})

/** Read one response from a running bridge server. */
async function get(port: number, path: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`)
  return { status: response.status, body: await response.text() }
}

/** Connect, send one message, and resolve with the first message back. */
function roundTrip(url: string, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    let settled = false
    const settle = (error?: Error, value?: string) => {
      if (settled) return
      settled = true
      socket.onerror = null
      socket.onmessage = null
      socket.onopen = null
      // A failed connect is already closed by the client; closing again would
      // re-enter onerror.
      socket.close()
      if (error === undefined) resolve(value as string)
      else reject(error)
    }
    socket.onerror = () => settle(new Error('socket error'))
    socket.onopen = () => socket.send(message)
    socket.onmessage = event => settle(undefined, String(event.data))
  })
}

describe('bridge server', () => {
  it('serves an exact route and rejects everything else', async () => {
    const { server, port } = await start()
    server.register({
      kind: 'exact',
      path: '/chrome-browser/ext/status',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      },
    })
    await expect(get(port, '/chrome-browser/ext/status')).resolves.toEqual({ status: 200, body: '{"ok":true}' })
    // The query string is not part of the route key.
    await expect(get(port, '/chrome-browser/ext/status?clear=1')).resolves.toEqual({ status: 200, body: '{"ok":true}' })
    await expect(get(port, '/chrome-browser/nope')).resolves.toEqual({
      status: 404,
      body: '{"ok":false,"error":"not found"}',
    })
  })

  it('reports a failing handler as 500 instead of dropping the request', async () => {
    const { server, port } = await start()
    server.register({
      kind: 'exact',
      path: '/boom',
      handler: () => {
        throw new Error('handler exploded')
      },
    })
    const response = await get(port, '/boom')
    expect(response.status).toBe(500)
    expect(JSON.parse(response.body)).toMatchObject({ ok: false })
  })

  it('refuses prefix routes, which only the dsh carrier supports', async () => {
    const { server } = await start()
    expect(() => server.register({ kind: 'prefix', path: '/x', handler: () => {} }))
      .toThrow('only serves exact routes')
  })

  it('removes a route when its disposer runs', async () => {
    const { server, port } = await start()
    const dispose = server.register({ kind: 'exact', path: '/once', handler: (_req, res) => { res.end('x') } })
    expect((await get(port, '/once')).status).toBe(200)
    dispose()
    expect((await get(port, '/once')).status).toBe(404)
  })

  it('hands an upgrade to its route and round-trips a frame', async () => {
    const { server, port } = await start()
    server.registerUpgrade({
      path: '/chrome-browser/ext/ws',
      handler: (req, socket, head) => {
        if (!wsHandshake(req, socket)) return
        const connection = new WsConnection(socket, head)
        connection.onMessage(text => connection.send(`echo:${text}`))
      },
    })
    await expect(roundTrip(`ws://127.0.0.1:${port}/chrome-browser/ext/ws`, 'hello'))
      .resolves.toBe('echo:hello')
  })

  it('destroys an upgrade for a path no route claims', async () => {
    const { server, port } = await start()
    server.registerUpgrade({
      path: '/chrome-browser/ext/ws',
      handler: (req, socket) => {
        wsHandshake(req, socket)
      },
    })
    await expect(roundTrip(`ws://127.0.0.1:${port}/other`, 'hello')).rejects.toThrow()
  })

  it('reports the OS-assigned port after binding port 0', async () => {
    const { server, port } = await start()
    expect(port).toBeGreaterThan(0)
    expect(server.port).toBe(port)
  })

  it('fails the bind when another process owns the port, and can be closed', async () => {
    const first = await start()
    const second = new BridgeServer()
    running.push(second)
    await expect(second.listen(first.port)).rejects.toThrow(/EADDRINUSE/u)
    await expect(second.close()).resolves.toBeUndefined()
    // The owner is unaffected by the failed attempt.
    await expect(get(first.port, '/nope')).resolves.toMatchObject({ status: 404 })
  })

  it('refuses to listen twice', async () => {
    const { server } = await start()
    await expect(server.listen(0)).rejects.toThrow('already listening')
  })

  it('closes a listener whose bind lands after close was requested', async () => {
    const server = new BridgeServer()
    const pending = server.listen(0)
    // The disposer can run in the window between `listen` and the bind
    // callback; the listener that lands afterwards must not outlive the close.
    await server.close()
    const port = await pending
    expect(server.port).toBeUndefined()
    await expect(fetch(`http://127.0.0.1:${port}/x`)).rejects.toThrow()
  })

  it('stops answering after close and drops its routes', async () => {
    const { server, port } = await start()
    server.register({ kind: 'exact', path: '/x', handler: (_req, res) => { res.end('x') } })
    await server.close()
    await expect(get(port, '/x')).rejects.toThrow()
    await expect(server.close()).resolves.toBeUndefined()
    expect(server.port).toBeUndefined()
  })
})
