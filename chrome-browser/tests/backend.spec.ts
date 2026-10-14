/**
 * Extension-bridge backend unit tests: command queueing, frame round-trips
 * (with a fake duplex that speaks the wire), reconnect semantics, and the
 * offline ensure() error. No real Chrome or network is involved.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { ExtensionBackend } from '../src/backend.ts'
import { resolveChromeConfig } from '../src/chrome.ts'
import type { CapturedMessage } from '../src/console-events.ts'

/**
 * A fake upgraded socket: captures written bytes, feeds responses back. It is
 * not declared `implements Duplex` — `Duplex` is a class, and only the members
 * the connection actually touches are modelled here; call sites cast.
 */
class FakeSocket extends EventEmitter {
  written: Buffer[] = []
  destroyed = false

  write(chunk: Buffer | string): boolean {
    this.written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return true
  }

  end(): this {
    return this
  }

  destroy(): this {
    this.destroyed = true
    return this
  }

  /** Feed raw bytes (e.g. a masked client frame) to the connection parser. */
  feed(chunk: Buffer): void {
    this.emit('data', chunk)
  }

  /** Encode one masked client text frame (per RFC 6455). */
  static clientText(text: string): Buffer {
    const payload = Buffer.from(text, 'utf8')
    const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
    const masked = Buffer.allocUnsafe(payload.length)
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i & 3]!
    let header: Buffer
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length])
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4)
      header[0] = 0x81
      header[1] = 0x80 | 126
      header.writeUInt16BE(payload.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x81
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    return Buffer.concat([header, mask, masked])
  }

  /** The last server frame's text payload (unmasked, text opcode). */
  lastServerText(): string | undefined {
    for (let i = this.written.length - 1; i >= 0; i--) {
      const frame = this.written[i]!
      const payload = frame.subarray(2)
      if ((frame[0]! & 0x0f) === 0x1) return payload.toString('utf8')
    }
    return undefined
  }
}

function makeBackend(autoRelaunchTimeout = 100) {
  const backend = new ExtensionBackend(resolveChromeConfig({ timeoutMs: autoRelaunchTimeout }))
  const socket = new FakeSocket()
  backend.attach(socket as never, Buffer.alloc(0))
  return { backend, socket }
}

describe('ExtensionBackend', () => {
  it('rejects with an install hint when nothing is attached', async () => {
    const backend = new ExtensionBackend(resolveChromeConfig({ timeoutMs: 80 }))
    await expect(backend.ensure()).rejects.toThrow('chrome://extensions')
  })

  it('queues a command, sends it over the wire and resolves on the result', async () => {
    const { backend, socket } = makeBackend()
    const outcome = backend.listTabs()
    await new Promise(resolve => setTimeout(resolve, 10))
    const sent = socket.lastServerText()
    expect(sent).not.toBeUndefined()
    const message = JSON.parse(sent!) as { kind: string; commands: Array<{ seq: number; op: string }> }
    expect(message.kind).toBe('commands')
    expect(message.commands[0]?.op).toBe('list-tabs')
    const seq = message.commands[0]!.seq
    const reply = JSON.stringify({ kind: 'results', results: [{ seq, ok: true, data: { tabs: [{ id: 7, title: 'T', url: 'u', active: true, favicon: 'f' }] } }] })
    socket.feed(FakeSocket.clientText(reply))
    await expect(outcome).resolves.toMatchObject([{ id: '7', title: 'T' }])
  })

  it('waits for the load without sending a command when the bound is zero', async () => {
    const { backend, socket } = makeBackend(5000)
    await backend.waitForLoad('1', 0)
    expect(socket.lastServerText()).toBeUndefined()
  })

  it('stops waiting as soon as the page reports complete', async () => {
    const { backend, socket } = makeBackend(5000)
    const waiting = backend.waitForLoad('1', 5000)
    await new Promise(resolve => setTimeout(resolve, 10))
    const sent = JSON.parse(socket.lastServerText()!) as { commands: Array<{ seq: number; op: string }> }
    expect(sent.commands[0]!.op).toBe('eval')
    socket.feed(FakeSocket.clientText(JSON.stringify({
      kind: 'results',
      results: [{ seq: sent.commands[0]!.seq, ok: true, data: 'complete' }],
    })))
    await expect(waiting).resolves.toBeUndefined()
  })

  it('sends console capture commands over the wire', async () => {
    const { backend, socket } = makeBackend(5000)
    const started = backend.startConsole('7')
    await new Promise(resolve => setTimeout(resolve, 10))
    const first = JSON.parse(socket.lastServerText()!) as { commands: Array<{ seq: number; op: string; args: { tabId: string } }> }
    expect(first.commands[0]).toMatchObject({ op: 'console-start', args: { tabId: '7' } })
    socket.feed(FakeSocket.clientText(JSON.stringify({
      kind: 'results',
      results: [{ seq: first.commands[0]!.seq, ok: true, data: { tabId: '7' } }],
    })))
    await expect(started).resolves.toBeUndefined()

    const stopped = backend.stopConsole('7')
    await new Promise(resolve => setTimeout(resolve, 10))
    const second = JSON.parse(socket.lastServerText()!) as { commands: Array<{ seq: number; op: string }> }
    expect(second.commands[0]!.op).toBe('console-stop')
    socket.feed(FakeSocket.clientText(JSON.stringify({
      kind: 'results',
      results: [{ seq: second.commands[0]!.seq, ok: true, data: { tabId: '7' } }],
    })))
    await expect(stopped).resolves.toBeUndefined()
  })

  it('routes a pushed console event frame to the sink', () => {
    const received: Array<[string, CapturedMessage]> = []
    const backend = new ExtensionBackend(
      resolveChromeConfig({ timeoutMs: 100 }),
      (tabId, message) => { received.push([tabId, message]) },
    )
    const socket = new FakeSocket()
    backend.attach(socket as never, Buffer.alloc(0))
    socket.feed(FakeSocket.clientText(JSON.stringify({
      kind: 'event',
      event: 'console',
      tabId: 7,
      entries: [
        { level: 'error', text: 'boom', source: 'app.js:1' },
        { level: 'log', text: 'hi' },
      ],
    })))
    expect(received).toEqual([
      ['7', { level: 'error', text: 'boom', source: 'app.js:1' }],
      ['7', { level: 'log', text: 'hi' }],
    ])
  })

  it('drops a malformed event frame without disturbing the connection', async () => {
    const received: Array<[string, CapturedMessage]> = []
    const backend = new ExtensionBackend(
      resolveChromeConfig({ timeoutMs: 5000 }),
      (tabId, message) => { received.push([tabId, message]) },
    )
    const socket = new FakeSocket()
    backend.attach(socket as never, Buffer.alloc(0))
    for (const frame of [
      { kind: 'event' },
      { kind: 'event', event: 'other', tabId: 1, entries: [{ level: 'log', text: 'x' }] },
      { kind: 'event', event: 'console', tabId: '', entries: [{ level: 'log', text: 'x' }] },
      { kind: 'event', event: 'console', tabId: 1, entries: 'not an array' },
      { kind: 'event', event: 'console', tabId: 1, entries: [null, 'x', { level: 'log' }, { text: '' }] },
    ]) {
      socket.feed(FakeSocket.clientText(JSON.stringify(frame)))
    }
    expect(received).toEqual([])

    // The connection still carries commands afterwards. The console ops are
    // retry-safe, so a disconnect would not explain a silent loss here.
    const outcome = backend.listTabs()
    await new Promise(resolve => setTimeout(resolve, 10))
    const sent = JSON.parse(socket.lastServerText()!) as { commands: Array<{ seq: number; op: string }> }
    expect(sent.commands[0]!.op).toBe('list-tabs')
    socket.feed(FakeSocket.clientText(JSON.stringify({
      kind: 'results',
      results: [{ seq: sent.commands[0]!.seq, ok: true, data: { tabs: [] } }],
    })))
    await expect(outcome).resolves.toEqual([])
  })

  it('rejects with the extension error message', async () => {
    const { backend, socket } = makeBackend()
    const outcome = backend.evaluate('1', 'boom()')
    await new Promise(resolve => setTimeout(resolve, 10))
    const sent = JSON.parse(socket.lastServerText()!) as { commands: Array<{ seq: number }> }
    const seq = sent.commands[0]!.seq
    socket.feed(FakeSocket.clientText(JSON.stringify({
      kind: 'results',
      results: [{ seq, ok: false, error: 'page crashed' }],
    })))
    await expect(outcome).rejects.toThrow('page crashed')
  })

  it('times out an unanswered command', async () => {
    const { backend } = makeBackend(50)
    await expect(backend.listTabs()).rejects.toThrow('超时')
  })

  it('rejects side-effectful commands immediately when the bridge detaches', async () => {
    const { backend, socket } = makeBackend(5000)
    let rejection: Error | undefined
    const outcome = backend.click('1', '#go', false).catch((error: Error) => { rejection = error })
    socket.emit('close')
    backend.detach()
    await outcome
    // The click was dispatched and the reply never came: the model must not
    // read this as "it failed" and click again.
    expect(rejection?.message).toContain('结果未知')
    expect(rejection?.message).toContain('不要直接重试')
    expect(rejection?.message).toContain('chrome_read')
  })

  it('reports a timed-out side-effectful command as an unknown outcome', async () => {
    const { backend } = makeBackend(60)
    await expect(backend.type('1', '#inp', 'hunter2', true)).rejects.toThrow(/结果未知.*不要直接重试/u)
  })

  it('reports a timed-out read as a plain failure, which is safe to retry', async () => {
    const { backend } = makeBackend(60)
    const failure = await backend.listTabs().catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('超时')
    expect((failure as Error).message).not.toContain('结果未知')
  })

  it('keeps side-effect-free commands through a disconnect and resends on reconnect', async () => {
    const { backend, socket } = makeBackend(300)
    const outcome = backend.listTabs()
    void outcome.catch(() => { /* defensive: resolved via reconnect below */ })
    await new Promise(resolve => setTimeout(resolve, 10))
    socket.emit('close')
    backend.detach()
    // not rejected immediately; the grace window holds it
    let settled = false
    void outcome.finally(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(settled).toBe(false)
    // reconnect and see the command re-sent, then answer it
    const socket2 = new FakeSocket()
    backend.attach(socket2 as never, Buffer.alloc(0))
    await new Promise(resolve => setTimeout(resolve, 10))
    const sent = JSON.parse(socket2.lastServerText()!) as { commands: Array<{ seq: number; op: string }> }
    expect(sent.commands[0]?.op).toBe('list-tabs')
    socket2.feed(FakeSocket.clientText(JSON.stringify({
      kind: 'results',
      results: [{ seq: sent.commands[0]!.seq, ok: true, data: { tabs: [] } }],
    })))
    await expect(outcome).resolves.toEqual([])
  })

  it('de-duplicates concurrent side-effectful commands by key', async () => {
    const { backend, socket } = makeBackend(5000)
    const first = backend.click('7', '#go', false)
    const second = backend.click('7', '#go', false)
    await new Promise(resolve => setTimeout(resolve, 10))
    // exactly one wire command (the second joined it)
    const sent = socket.lastServerText()!
    expect((JSON.parse(sent) as { commands: unknown[] }).commands).toHaveLength(1)
    const seq = (JSON.parse(sent) as { commands: Array<{ seq: number }> }).commands[0]!.seq
    socket.feed(FakeSocket.clientText(JSON.stringify({
      kind: 'results',
      results: [{ seq, ok: true, data: 1 }],
    })))
    // `data: 1` is the pre-0.4 bridge reply: a bare count, which maps onto the
    // outcome shape so an extension not yet reloaded keeps working.
    const legacy = { matched: 1, clicked: 1, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0 }
    await expect(first).resolves.toEqual(legacy)
    await expect(second).resolves.toEqual(legacy)
  })

  it('passes a current bridge click outcome through unchanged', async () => {
    const { backend, socket } = makeBackend(5000)
    const outcome = backend.click('7', '#go', true)
    await new Promise(resolve => setTimeout(resolve, 10))
    const seq = (JSON.parse(socket.lastServerText()!) as { commands: Array<{ seq: number }> }).commands[0]!.seq
    const data = { matched: 3, clicked: 2, disabled: 1, invisible: 1, offscreen: 0, covered: 0, ariaDisabled: 0 }
    socket.feed(FakeSocket.clientText(JSON.stringify({ kind: 'results', results: [{ seq, ok: true, data }] })))
    await expect(outcome).resolves.toEqual(data)
  })

  it('does NOT replay an unsettled open command after a detach/reconnect', async () => {
    const { backend, socket } = makeBackend(5000)
    const outcome = backend.openTab('https://example.com/new')
    void outcome.catch(() => { /* defensive: settled via reuse below */ })
    await new Promise(resolve => setTimeout(resolve, 10))
    // delivered but never acknowledged; bridge drops
    socket.emit('close')
    backend.detach()
    // reconnect with a fresh socket: the side-effectful `open` must NOT be
    // re-sent; the safe inner list-tabs may be (reuse guard resolves it).
    const socket2 = new FakeSocket()
    backend.attach(socket2 as never, Buffer.alloc(0))
    await new Promise(resolve => setTimeout(resolve, 10))
    const sentText = JSON.stringify(socket2.written.map(b => b.toString('utf8')))
    expect(sentText).not.toContain('example.com/new')
    const sent = JSON.parse(socket2.lastServerText()!) as { commands: Array<{ seq: number; op: string }> }
    if (sent.commands[0]?.op === 'list-tabs') {
      socket2.feed(FakeSocket.clientText(JSON.stringify({
        kind: 'results',
        results: [{ seq: sent.commands[0]!.seq, ok: true, data: { tabs: [{ id: 9, title: 'Existing', url: 'https://example.com/new', active: true, favicon: '' }] } }],
      })))
    }
    await expect(outcome).resolves.toMatchObject({ id: '9' })
  }, 8000)

  it('reuses an existing tab for the same url instead of re-opening', async () => {
    const { backend, socket } = makeBackend(5000)
    const outcome = backend.openTab('https://example.com/')
    await new Promise(resolve => setTimeout(resolve, 10))
    const sent = JSON.parse(socket.lastServerText()!) as { commands: Array<{ seq: number; op: string }> }
    // answer the internal list-tabs with an existing tab
    const seq = sent.commands[0]!.seq
    socket.feed(FakeSocket.clientText(JSON.stringify({
      kind: 'results',
      results: [{ seq, ok: true, data: { tabs: [{ id: 9, title: 'Existing', url: 'https://example.com/', active: true, favicon: '' }] } }],
    })))
    await expect(outcome).resolves.toMatchObject({ id: '9', title: 'Existing' })
    // only the list-tabs command was sent; no 'open' followed
    expect(sent.commands.some(cmd => cmd.op === 'open')).toBe(false)
  })

  /** Answer the most recent command with one serialized result. */
  async function answer(backend: { evaluate(tabId: string, expression: string): Promise<unknown> }, socket: FakeSocket, data: unknown): Promise<unknown> {
    const outcome = backend.evaluate('7', '1 + 1')
    await new Promise(resolve => setTimeout(resolve, 10))
    const sent = JSON.parse(socket.lastServerText()!) as { commands: Array<{ seq: number }> }
    socket.feed(FakeSocket.clientText(JSON.stringify({
      kind: 'results',
      results: [{ seq: sent.commands[0]!.seq, ok: true, data }],
    })))
    return outcome
  }

  it('unwraps a tagged eval envelope and remembers which world answered', async () => {
    const { backend, socket } = makeBackend()
    await expect(answer(backend, socket, { __dshEval: 1, ok: true, value: 42, world: 'main' })).resolves.toBe(42)
    expect(backend.lastEvalWorld).toBe('main')

    await expect(answer(backend, socket, { __dshEval: 1, ok: true, value: 7, world: 'debugger' })).resolves.toBe(7)
    expect(backend.lastEvalWorld).toBe('debugger')
  })

  it('turns a tagged eval failure into an error instead of a null value', async () => {
    // The whole point of the envelope: a syntax error, a runtime throw and a
    // blocked `eval` used to reach the model as `null`.
    const { backend, socket } = makeBackend()
    await expect(answer(backend, socket, { __dshEval: 1, ok: false, error: 'boom-xyz is not defined' }))
      .rejects.toThrow(/boom-xyz is not defined/)
    expect(backend.lastEvalWorld).toBeUndefined()
  })

  it('passes an untagged answer through, for an extension built before the envelope', async () => {
    const { backend, socket } = makeBackend()
    await expect(answer(backend, socket, { ok: true, value: 1 })).resolves.toEqual({ ok: true, value: 1 })
    expect(backend.lastEvalWorld).toBeUndefined()
  })

  it('passes a bare scalar through unchanged', async () => {
    const { backend, socket } = makeBackend()
    await expect(answer(backend, socket, 2)).resolves.toBe(2)
  })

  /** Feed one hello, the message the extension introduces itself with. */
  function hello(socket: FakeSocket, build: string, ops: string[], version = '0.0.1'): void {
    socket.feed(FakeSocket.clientText(JSON.stringify({ kind: 'hello', version, ops, build })))
  }

  it('refuses an op the extension does not advertise, naming the real cause', async () => {
    // Sending it anyway earns `unknown op` from the extension: an internal error
    // that says nothing about an extension whose files are older than the
    // plugin driving it — which is what actually happened before this.
    const { backend, socket } = makeBackend()
    hello(socket, 'stale-build', ['list-tabs'])
    await expect(backend.closeTab('7')).rejects.toThrow(/扩展不支持 close/u)
    await expect(backend.closeTab('7')).rejects.toThrow(/chrome:\/\/extensions/u)
  })

  it('still sends an op the extension does advertise', async () => {
    const { backend, socket } = makeBackend()
    hello(socket, 'stale-build', ['list-tabs', 'close'])
    const outcome = backend.closeTab('7')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(socket.lastServerText()).toContain('"op":"close"')
    await new Promise(resolve => setTimeout(resolve, 10))
    const sent = JSON.parse(socket.lastServerText()!) as { commands: Array<{ seq: number }> }
    socket.feed(FakeSocket.clientText(JSON.stringify({
      kind: 'results', results: [{ seq: sent.commands[0]!.seq, ok: true, data: { tabId: '7' } }],
    })))
    await expect(outcome).resolves.toBeUndefined()
  })

  it('asks a stale extension to reload itself', async () => {
    const { backend, socket } = makeBackend()
    hello(socket, 'stale-build', ['list-tabs', 'reload'])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(socket.lastServerText()).toContain('"op":"reload"')
    expect(backend.extensionStatus()).toMatchObject({ build: 'stale-build', stale: true, autoReloadAsked: true })
  })

  it('never asks twice about the same stale build', async () => {
    // If a reload cannot move the extension off one version, asking on every
    // heartbeat would reload it forever.
    const { backend, socket } = makeBackend()
    hello(socket, 'stale-build', ['list-tabs', 'reload'])
    await new Promise(resolve => setTimeout(resolve, 10))
    const before = socket.written.length
    hello(socket, 'stale-build', ['list-tabs', 'reload'])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(socket.written.length).toBe(before)
    expect(backend.extensionStatus().autoReloadAsked).toBe(true)
  })

  it('asks again when the mismatch moves to a new build', async () => {
    // Two upgrades inside one host process: the second must settle too, even
    // though the first already spent an attempt.
    const { backend, socket } = makeBackend()
    hello(socket, 'stale-build', ['list-tabs', 'reload'])
    await new Promise(resolve => setTimeout(resolve, 10))
    const firstAsk = socket.written.length
    hello(socket, 'newer-build', ['list-tabs', 'reload'])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(socket.written.length).toBeGreaterThan(firstAsk)
    expect(socket.lastServerText()).toContain('"op":"reload"')
    expect(backend.extensionStatus()).toMatchObject({ build: 'newer-build', stale: true })
  })

  it('leaves a current extension alone', async () => {
    const { backend, socket } = makeBackend()
    const current = backend.extensionStatus().expectedBuild
    expect(current).toMatch(/^[0-9a-f]{64}$/u)
    hello(socket, current, ['list-tabs', '0.3.0'])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(backend.extensionStatus()).toMatchObject({ build: current, stale: false, autoReloadAsked: false })
    expect(socket.lastServerText() ?? '').not.toContain('"op":"reload"')
  })

  it('calls a changed extension stale even when its version was not bumped', async () => {
    // The failure a version-only check cannot see: same version, new code.
    const { backend, socket } = makeBackend()
    hello(socket, 'edited-without-a-version-bump', ['list-tabs', 'reload'], '0.3.0')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(backend.extensionStatus()).toMatchObject({
      version: '0.3.0',
      expectedVersion: '0.3.0',
      stale: true,
    })
    expect(socket.lastServerText()).toContain('"op":"reload"')
  })

  it('cannot ask an extension that predates the handshake to reload', async () => {
    // Without a reload op there is nothing to ask; the answer is the manual
    // step, and the status route reports the mismatch.
    const { backend, socket } = makeBackend()
    hello(socket, 'stale-build', ['list-tabs'])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(backend.extensionStatus()).toMatchObject({ stale: true, autoReloadAsked: false })
  })

  it('sends keep-alive pings to the LIVE socket after a reconnect', () => {
    const { backend, socket } = makeBackend(5000)
    vi.useFakeTimers()
    try {
      socket.emit('close')
      backend.detach()
      const socket2 = new FakeSocket()
      backend.attach(socket2 as never, Buffer.alloc(0))
      vi.advanceTimersByTime(10_000)
      const liveText = socket2.written.map(b => b.toString('utf8')).join('\n')
      const oldText = socket.written.map(b => b.toString('utf8')).join('\n')
      expect(liveText).toContain('kind":"ping')
      expect(oldText).not.toContain('kind":"ping')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports connection state', () => {
    const { backend } = makeBackend()
    expect(backend.isConnected()).toBe(true)
    backend.detach()
    expect(backend.isConnected()).toBe(false)
  })
})
