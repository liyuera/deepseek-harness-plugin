/**
 * Minimal WebSocket server for the extension bridge: RFC 6455 handshake,
 * text frames only (client frames arrive masked, server frames unmasked),
 * no extensions or subprotocols.
 *
 * Fragmented messages are reassembled. Chrome splits a large message into
 * continuation frames, so a bridge result of a few hundred kilobytes arrives
 * that way — treating a non-final frame as a protocol error closed the socket
 * and left the command unacknowledged, which the host then re-sent in a loop.
 * @module @liyuera/dsh-chrome-browser/ws
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Server-frame opcodes we emit. */
const OP_TEXT = 0x1
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xA
/** Continuation of a fragmented message (RFC 6455 5.4). */
const OP_CONTINUATION = 0x0

/**
 * Perform the RFC 6455 opening handshake on an upgraded socket.
 * @returns false when the request is not a valid upgrade (socket destroyed).
 */
export function wsHandshake(req: IncomingMessage, socket: Duplex): boolean {
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || key === '') {
    socket.destroy()
    return false
  }
  const accept = createHash('sha1').update(`${key}${WS_GUID}`, 'utf8').digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  return true
}

/** Encode one text frame (unmasked, server side). */
function textFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const mask = 0x80
  if (payload.length < 126) {
    const header = Buffer.from([mask | OP_TEXT, payload.length])
    return Buffer.concat([header, payload])
  }
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4)
    header[0] = mask | OP_TEXT
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = mask | OP_TEXT
  header[1] = 127
  header.writeBigUInt64BE(BigInt(payload.length), 2)
  return Buffer.concat([header, payload])
}

/**
 * One attached WebSocket connection: incremental frame parsing (client
 * frames arrive masked), ping/pong handling, and a message sink.
 */
export class WsConnection {
  private readonly socket: Duplex
  private buffer: Buffer = Buffer.alloc(0)
  /** Payloads of the message being reassembled, and the opcode that opened it. */
  private fragments: Buffer[] = []
  private fragmentOpcode = 0
  private readonly listeners = new Set<(text: string) => void>()

  constructor(socket: Duplex, head: Buffer) {
    this.socket = socket
    socket.on('data', chunk => this.feed(chunk as Buffer))
    socket.on('close', () => this.listeners.clear())
    socket.on('error', () => this.socket.destroy())
    this.buffer = Buffer.concat([Buffer.alloc(0), head])
    if (head.length > 0) this.feed(head)
  }

  /** Subscribe to text messages; returns the disposer. */
  onMessage(listener: (text: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Send one text message (server frame, unmasked). */
  send(text: string): void {
    this.socket.write(textFrame(text))
  }

  /** Send a ping (client answers pong automatically per protocol). */
  ping(): void {
    this.socket.write(Buffer.from([0x80 | OP_PING, 0]))
  }

  /** Close the connection (close frame + destroy). */
  close(): void {
    try {
      this.socket.write(Buffer.from([OP_CLOSE, 0]))
    } catch {
      // already gone
    }
    this.socket.destroy()
  }

  private feed(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    for (;;) {
      const frame = this.readFrame()
      if (frame === null) break
      const { final, opcode, payload } = frame

      // Control frames may arrive in the middle of a fragmented message and are
      // never themselves fragmented, so they are answered without touching the
      // reassembly state.
      if (opcode === OP_PING) {
        this.socket.write(Buffer.from([0x80 | OP_PONG, payload.length]))
        continue
      }
      if (opcode === OP_CLOSE) {
        this.close()
        return
      }
      if (opcode !== OP_TEXT && opcode !== OP_CONTINUATION) continue

      if (opcode === OP_CONTINUATION) {
        // A continuation with nothing open is a protocol error.
        if (this.fragments.length === 0 && this.fragmentOpcode === 0) {
          this.socket.destroy()
          return
        }
        this.fragments.push(payload)
      } else {
        // A new data message before the previous one finished is a protocol error.
        if (this.fragmentOpcode !== 0) {
          this.socket.destroy()
          return
        }
        this.fragmentOpcode = opcode
        this.fragments = [payload]
      }
      if (!final) continue

      const whole = this.fragments.length === 1
        ? (this.fragments[0] as Buffer)
        : Buffer.concat(this.fragments)
      this.fragments = []
      this.fragmentOpcode = 0
      const text = whole.toString('utf8')
      for (const listener of this.listeners) listener(text)
    }
  }

  /** Parse one frame off the buffer; null when incomplete. */
  private readFrame(): { final: boolean; opcode: number; payload: Buffer } | null {
    if (this.buffer.length < 2) return null
    const b0 = this.buffer[0]!
    const b1 = this.buffer[1]!
    const final = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let length = b1 & 0x7f
    let offset = 2
    if (length === 126) {
      if (this.buffer.length < 4) return null
      length = this.buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (this.buffer.length < 10) return null
      const big = this.buffer.readBigUInt64BE(2)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.socket.destroy()
        return null
      }
      length = Number(big)
      offset = 10
    }
    let maskKey: Buffer | null = null
    if (masked) {
      if (this.buffer.length < offset + 4) return null
      maskKey = this.buffer.subarray(offset, offset + 4)
      offset += 4
    }
    if (this.buffer.length < offset + length) return null
    let payload = this.buffer.subarray(offset, offset + length)
    if (maskKey !== null) {
      const decoded = Buffer.allocUnsafe(length)
      for (let i = 0; i < length; i++) decoded[i] = payload[i]! ^ maskKey[i & 3]!
      payload = decoded
    }
    this.buffer = this.buffer.subarray(offset + length)
    return { final, opcode, payload: Buffer.from(payload) }
  }
}
