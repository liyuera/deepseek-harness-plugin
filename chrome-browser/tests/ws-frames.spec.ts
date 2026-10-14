/**
 * The bridge's frame parser, against the frames a browser actually sends.
 *
 * Chrome splits a large WebSocket message into continuation frames. The parser
 * used to treat any non-final frame as impossible and destroy the socket, so a
 * `chrome_read` of a page with a few hundred kilobytes of text closed the bridge
 * on every attempt: the host never received the result, re-sent the command on
 * reconnect, and the extension re-sent the same oversized frame — a loop that
 * only ended when the tab navigated somewhere smaller.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { WsConnection } from '../src/ws.ts'

/** A duplex stand-in that records writes and lets a test push frames in. */
class FakeSocket extends EventEmitter {
  readonly written: Buffer[] = []
  destroyed = false

  write(chunk: Buffer): boolean {
    this.written.push(chunk)
    return true
  }

  destroy(): void {
    this.destroyed = true
  }
}

/** One client frame: masked, as a browser sends them. */
function frame(payload: string, options: { final?: boolean; opcode?: number } = {}): Buffer {
  const body = Buffer.from(payload, 'utf8')
  const mask = Buffer.from([1, 2, 3, 4])
  const masked = Buffer.allocUnsafe(body.length)
  for (let index = 0; index < body.length; index += 1) masked[index] = body[index]! ^ mask[index & 3]!
  const header = [((options.final ?? true) ? 0x80 : 0) | (options.opcode ?? 0x1)]
  if (body.length < 126) header.push(0x80 | body.length)
  else if (body.length <= 0xffff) header.push(0x80 | 126, body.length >> 8, body.length & 0xff)
  else {
    header.push(0x80 | 127, 0, 0, 0, 0)
    header.push((body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff)
  }
  return Buffer.concat([Buffer.from(header), mask, masked])
}

/** An attached connection over a fake socket, plus what its listener saw. */
function bench(): { conn: WsConnection; socket: FakeSocket; messages: string[] } {
  const socket = new FakeSocket()
  const conn = new WsConnection(socket as never, Buffer.alloc(0))
  const messages: string[] = []
  conn.onMessage(text => messages.push(text))
  return { conn, socket, messages }
}

describe('WsConnection frames', () => {
  it('delivers one unfragmented text message', () => {
    const { socket, messages } = bench()
    socket.emit('data', frame('{"hello":1}'))
    expect(messages).toEqual(['{"hello":1}'])
  })

  it('reassembles a message split across continuation frames', () => {
    const { socket, messages, conn } = bench()
    socket.emit('data', frame('{"a":', { final: false }))
    socket.emit('data', frame('1', { final: false, opcode: 0x0 }))
    socket.emit('data', frame('}', { final: true, opcode: 0x0 }))
    expect(socket.destroyed).toBe(false)
    expect(messages).toEqual(['{"a":1}'])
    expect(conn).toBeDefined()
  })

  it('reassembles when the fragments arrive in one chunk', () => {
    const { socket, messages } = bench()
    socket.emit('data', Buffer.concat([
      frame('{"a":', { final: false }),
      frame('1}', { final: true, opcode: 0x0 }),
    ]))
    expect(messages).toEqual(['{"a":1}'])
  })

  it('reassembles a frame split mid-header across chunks', () => {
    const { socket, messages } = bench()
    const whole = frame('{"a":1}')
    socket.emit('data', whole.subarray(0, 3))
    socket.emit('data', whole.subarray(3))
    expect(messages).toEqual(['{"a":1}'])
  })

  it('answers a ping that lands between fragments without losing them', () => {
    const { socket, messages } = bench()
    socket.emit('data', frame('{"a":', { final: false }))
    socket.emit('data', frame('', { opcode: 0x9 }))
    socket.emit('data', frame('1}', { final: true, opcode: 0x0 }))
    expect(messages).toEqual(['{"a":1}'])
    // 0x8A: FIN + pong.
    expect(socket.written[0]?.[0]).toBe(0x8a)
  })

  it('carries a message larger than the 16-bit length field', () => {
    const { socket, messages } = bench()
    const big = 'x'.repeat(200_000)
    socket.emit('data', frame(JSON.stringify({ big })))
    expect(messages).toHaveLength(1)
    expect((JSON.parse(messages[0] as string) as { big: string }).big).toHaveLength(200_000)
  })

  it('carries a fragmented message larger than the 16-bit length field', () => {
    const { socket, messages } = bench()
    const half = 'y'.repeat(100_000)
    socket.emit('data', frame(half, { final: false }))
    socket.emit('data', frame(half, { final: true, opcode: 0x0 }))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toHaveLength(200_000)
  })

  it('still refuses a continuation with nothing open', () => {
    // A continuation that opens nothing is a protocol error, not a large message.
    const { socket } = bench()
    socket.emit('data', frame('orphan', { final: true, opcode: 0x0 }))
    expect(socket.destroyed).toBe(true)
  })

  it('still refuses a new message before the previous one finished', () => {
    const { socket } = bench()
    socket.emit('data', frame('{"a":', { final: false }))
    socket.emit('data', frame('{"b":1}'))
    expect(socket.destroyed).toBe(true)
  })

  it('closes on a close frame', () => {
    const { socket } = bench()
    socket.emit('data', frame('', { opcode: 0x8 }))
    expect(socket.written.some(chunk => chunk[0] === 0x08)).toBe(true)
    expect(socket.destroyed).toBe(true)
  })

  it('drops listeners when the socket closes', () => {
    const { socket, messages } = bench()
    socket.emit('close')
    socket.emit('data', frame('{"late":1}'))
    expect(messages).toEqual([])
  })

  it('destroys the socket on a transport error', () => {
    const { socket } = bench()
    socket.emit('error', new Error('ECONNRESET'))
    expect(socket.destroyed).toBe(true)
  })
})

describe('WsConnection send', () => {
  it('writes one unmasked text frame', () => {
    const { conn, socket } = bench()
    const write = vi.spyOn(socket, 'write')
    conn.send('{"ok":true}')
    const [chunk] = write.mock.calls[0] as [Buffer]
    expect(chunk[0]).toBe(0x81)
    expect(chunk[1]).toBe(11)
    expect(chunk.subarray(2).toString('utf8')).toBe('{"ok":true}')
  })

  it('uses the 64-bit length for a frame past 65535 bytes', () => {
    const { conn, socket } = bench()
    conn.send('z'.repeat(70_000))
    const [chunk] = socket.written as [Buffer]
    // Server frames are unmasked, so the length byte carries no mask bit.
    expect(chunk[1]).toBe(127)
    expect(chunk.readBigUInt64BE(2)).toBe(70_000n)
  })
})
