// Tier T3 (SPEC-DRAFT §8): WebSocket as a full-duplex byte pipe for the unchanged apü frame stream.
// RFC 6455 framing; handshake over HTTP/1.1 Upgrade or HTTP/2 extended CONNECT (RFC 8441, which
// Chrome, Firefox and Node's own WebSocket client use when the server advertises it). Node-only.
import { hash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';
import { Writable } from 'node:stream';
import { ApueError, ProblemType } from './protocol.ts';

export const WS_SUBPROTOCOL = 'apue.v0';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const WsOpcode = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa } as const;

export const WsClose = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  TOO_BIG: 1009,
} as const;

export class WsProtocolError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export function acceptKey(key: string): string {
  return hash('sha1', key + GUID, 'base64');
}

/** Unmasked frame (server → client). */
export function encodeWsFrame(opcode: number, payload: Uint8Array = new Uint8Array(0)): Buffer {
  const length = payload.byteLength;
  const headerLength = length < 126 ? 2 : length < 65536 ? 4 : 10;
  const out = Buffer.allocUnsafe(headerLength + length);
  out[0] = 0x80 | opcode; // FIN
  if (length < 126) {
    out[1] = length;
  } else if (length < 65536) {
    out[1] = 126;
    out.writeUInt16BE(length, 2);
  } else {
    out[1] = 127;
    out.writeBigUInt64BE(BigInt(length), 2);
  }
  out.set(payload, headerLength);
  return out;
}

export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Uint8Array;
}

/** Incremental parser for client → server frames (must be masked, no extensions). */
/**
 * Copies and unmasks a payload (RFC 6455 §5.3). 32-bit words are 4–5× faster than bytes from
 * 1 KiB on (measured: 4 vs 0.85 GB/s); the mask word is read in native byte order, so the XOR is
 * right on big-endian platforms too.
 */
function unmask(buf: Uint8Array, start: number, length: number, mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(length);
  if (length < 128) {
    for (let i = 0; i < length; i++) out[i] = buf[start + i]! ^ mask[i & 3]!;
    return out;
  }
  out.set(buf.subarray(start, start + length));
  const words = length >>> 2;
  const m = new Int32Array(Uint8Array.from(mask).buffer)[0]!;
  const view = new Int32Array(out.buffer, 0, words); // fresh buffer: offset 0 is aligned
  for (let i = 0; i < words; i++) view[i]! ^= m;
  for (let i = words << 2; i < length; i++) out[i]! ^= mask[i & 3]!;
  return out;
}

export class WsParser {
  readonly maxPayload: number;
  // Incomplete input is kept as a list and joined only once `#needed` bytes are there: joining on
  // every chunk would copy a large frame once per chunk (quadratic).
  #chunks: Uint8Array[] = [];
  #buffered = 0;
  #needed = 2;

  constructor(maxPayload: number) {
    this.maxPayload = maxPayload;
  }

  push(chunk: Uint8Array): WsFrame[] {
    this.#chunks.push(chunk);
    this.#buffered += chunk.byteLength;
    if (this.#buffered < this.#needed) return [];
    const buf = this.#chunks.length === 1 ? chunk : Buffer.concat(this.#chunks, this.#buffered);
    const frames: WsFrame[] = [];
    let needed = 2;
    let offset = 0;
    while (buf.byteLength - offset >= 2) {
      const b0 = buf[offset]!;
      const b1 = buf[offset + 1]!;
      if (b0 & 0x70) throw new WsProtocolError(WsClose.PROTOCOL_ERROR, 'reserved bits set (no extensions negotiated)');
      if (!(b1 & 0x80)) throw new WsProtocolError(WsClose.PROTOCOL_ERROR, 'client frames must be masked');
      const opcode = b0 & 0x0f;
      const fin = (b0 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let header = 2;
      if (length === 126) {
        if (buf.byteLength - offset < (needed = 4)) break;
        length = (buf[offset + 2]! << 8) | buf[offset + 3]!;
        header = 4;
      } else if (length === 127) {
        if (buf.byteLength - offset < (needed = 10)) break;
        const view = new DataView(buf.buffer, buf.byteOffset + offset + 2, 8);
        const big = view.getBigUint64(0);
        if (big > BigInt(this.maxPayload)) throw new WsProtocolError(WsClose.TOO_BIG, 'frame too large');
        length = Number(big);
        header = 10;
      }
      if (opcode >= 0x8) {
        if (!fin || length > 125) throw new WsProtocolError(WsClose.PROTOCOL_ERROR, 'invalid control frame');
      } else if (![WsOpcode.CONTINUATION, WsOpcode.TEXT, WsOpcode.BINARY].includes(opcode as 0 | 1 | 2)) {
        throw new WsProtocolError(WsClose.PROTOCOL_ERROR, `unknown opcode ${opcode}`);
      }
      if (length > this.maxPayload) throw new WsProtocolError(WsClose.TOO_BIG, 'frame too large');
      if (buf.byteLength - offset < (needed = header + 4 + length)) break;
      const start = offset + header + 4;
      frames.push({ fin, opcode, payload: unmask(buf, start, length, buf.subarray(offset + header, start)) });
      offset = start + length;
      needed = 2;
    }
    const rest = buf.subarray(offset);
    this.#chunks = rest.byteLength === 0 ? [] : [rest];
    this.#buffered = rest.byteLength;
    this.#needed = needed;
    return frames;
  }
}

/**
 * A server-side WebSocket connection carrying a byte stream in both directions. A background
 * reader answers pings and the close handshake even while nobody consumes data; data is buffered
 * up to `maxBuffered` bytes, after which the reader stops pulling from the transport (backpressure).
 */
export class WsConnection {
  /** Writes become binary frames; end() sends a close frame (1000) after everything written. */
  readonly sink: Writable;
  #io: Duplex;
  #queue: Uint8Array[] = [];
  #queued = 0;
  #inputEnded = false;
  #inputError: Error | undefined;
  #wake: (() => void) | undefined;
  #resumeReader: (() => void) | undefined;
  #closeSent = false;
  #closed = false;
  #closeCallbacks: Array<() => void> = [];
  #maxBuffered: number;

  constructor(io: Duplex, { maxPayload = 16 * 1024 * 1024, maxBuffered = 1024 * 1024, head = new Uint8Array(0) as Uint8Array } = {}) {
    this.#io = io;
    this.#maxBuffered = maxBuffered;
    this.sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        if (this.#closeSent || io.destroyed) return callback();
        if (io.write(encodeWsFrame(WsOpcode.BINARY, chunk))) return callback();
        // A transport that closes instead of draining must not leave the write pending forever.
        const done = () => {
          io.off('drain', done);
          io.off('close', done);
          callback();
        };
        io.on('drain', done);
        io.on('close', done);
      },
      final: (callback) => {
        this.close(WsClose.NORMAL);
        callback();
      },
    });
    this.sink.on('error', () => {});
    io.once('close', () => this.#onIoClose());
    io.on('error', () => {});
    void this.#read(new WsParser(maxPayload), head);
  }

  /** Incoming binary payload bytes (message boundaries are irrelevant to apü framing). */
  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      if (this.#queue.length > 0) {
        const chunk = this.#queue.shift()!;
        this.#queued -= chunk.byteLength;
        if (this.#queued < this.#maxBuffered) {
          const resume = this.#resumeReader;
          this.#resumeReader = undefined;
          resume?.();
        }
        yield chunk;
        continue;
      }
      if (this.#inputError) throw this.#inputError;
      if (this.#inputEnded) return;
      await new Promise<void>((resolve) => (this.#wake = resolve));
    }
  }

  close(code: number = WsClose.NORMAL, reason = ''): void {
    if (this.#closeSent || this.#io.destroyed) return;
    this.#closeSent = true;
    const reasonBytes = Buffer.from(reason).subarray(0, 123);
    const payload = Buffer.allocUnsafe(2 + reasonBytes.byteLength);
    payload.writeUInt16BE(code, 0);
    payload.set(reasonBytes, 2);
    this.#io.write(encodeWsFrame(WsOpcode.CLOSE, payload));
    this.#io.end();
  }

  onClose(callback: () => void): void {
    if (this.#closed) callback();
    else this.#closeCallbacks.push(callback);
  }

  async #read(parser: WsParser, head: Uint8Array): Promise<void> {
    let fragmentedText = false;
    // destroyOnReturn: false — returning after a close frame must not destroy the transport
    // before our own close frame has been flushed.
    const chunks = this.#io.iterator({ destroyOnReturn: false }) as AsyncIterable<Uint8Array>;
    async function* withHead(): AsyncGenerator<Uint8Array> {
      if (head.byteLength > 0) yield head;
      yield* chunks;
    }
    try {
      for await (const chunk of withHead()) {
        if (this.#queued >= this.#maxBuffered) await new Promise<void>((resolve) => (this.#resumeReader = resolve));
        for (const frame of parser.push(chunk)) {
          if (frame.opcode === WsOpcode.PING) {
            if (!this.#closeSent) this.#io.write(encodeWsFrame(WsOpcode.PONG, frame.payload));
          } else if (frame.opcode === WsOpcode.PONG) {
            // unsolicited pongs are allowed and ignored
          } else if (frame.opcode === WsOpcode.CLOSE) {
            const code = frame.payload.byteLength >= 2 ? (frame.payload[0]! << 8) | frame.payload[1]! : WsClose.NORMAL;
            this.#endInput(code === WsClose.NORMAL ? undefined : new ApueError(499, 'Client Closed Request', `WebSocket closed by peer (${code})`));
            this.close(code === 1005 || code === 1006 || code === 1015 ? WsClose.NORMAL : code);
            return;
          } else if (frame.opcode === WsOpcode.TEXT || (frame.opcode === WsOpcode.CONTINUATION && fragmentedText)) {
            fragmentedText = !frame.fin;
            throw new WsProtocolError(WsClose.UNSUPPORTED_DATA, 'apü uses binary messages only');
          } else {
            this.#queue.push(frame.payload);
            this.#queued += frame.payload.byteLength;
            this.#notify();
          }
        }
      }
      this.#endInput(new ApueError(499, 'Client Closed Request', 'WebSocket transport ended without close frame'));
    } catch (error) {
      const code = error instanceof WsProtocolError ? error.code : WsClose.PROTOCOL_ERROR;
      // Surface to the handler as a client error, not as a server failure.
      this.#endInput(new ApueError(400, 'Malformed Stream', (error as Error).message, { type: ProblemType.MALFORMED_STREAM }));
      this.close(code, (error as Error).message);
    }
  }

  #endInput(error: Error | undefined): void {
    if (this.#inputEnded) return;
    this.#inputEnded = true;
    this.#inputError = error;
    this.#notify();
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  #onIoClose(): void {
    this.#closed = true;
    this.sink.destroy(); // producers waiting for the sink's 'drain' get 'close' instead
    this.#resumeReader?.();
    this.#endInput(this.#closeSent ? undefined : new ApueError(499, 'Client Closed Request', 'WebSocket connection lost'));
    for (const callback of this.#closeCallbacks.splice(0)) callback();
  }
}

export interface HandshakeCheck {
  ok: boolean;
  status: number;
  reason?: string;
}

/** Validates version, subprotocol and Origin (protection against cross-site WebSocket hijacking). */
export function checkHandshake(headers: IncomingHttpHeaders, allowedOrigin: (origin: string) => boolean): HandshakeCheck {
  if (headers['sec-websocket-version'] !== '13') return { ok: false, status: 426, reason: 'Sec-WebSocket-Version 13 required' };
  const protocols = String(headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((p) => p.trim());
  if (!protocols.includes(WS_SUBPROTOCOL)) return { ok: false, status: 400, reason: `subprotocol ${WS_SUBPROTOCOL} required` };
  const origin = headers.origin;
  if (typeof origin === 'string' && !allowedOrigin(origin)) return { ok: false, status: 403, reason: 'origin not allowed' };
  return { ok: true, status: 200 };
}
