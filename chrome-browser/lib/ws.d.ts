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
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
/**
 * Perform the RFC 6455 opening handshake on an upgraded socket.
 * @returns false when the request is not a valid upgrade (socket destroyed).
 */
export declare function wsHandshake(req: IncomingMessage, socket: Duplex): boolean;
/**
 * One attached WebSocket connection: incremental frame parsing (client
 * frames arrive masked), ping/pong handling, and a message sink.
 */
export declare class WsConnection {
    private readonly socket;
    private buffer;
    /** Payloads of the message being reassembled, and the opcode that opened it. */
    private fragments;
    private fragmentOpcode;
    private readonly listeners;
    constructor(socket: Duplex, head: Buffer);
    /** Subscribe to text messages; returns the disposer. */
    onMessage(listener: (text: string) => void): () => void;
    /** Send one text message (server frame, unmasked). */
    send(text: string): void;
    /** Send a ping (client answers pong automatically per protocol). */
    ping(): void;
    /** Close the connection (close frame + destroy). */
    close(): void;
    private feed;
    /** Parse one frame off the buffer; null when incomplete. */
    private readFrame;
}
//# sourceMappingURL=ws.d.ts.map