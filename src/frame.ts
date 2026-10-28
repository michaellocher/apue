// apü frame codec (SPEC-DRAFT §6). Web-platform only (no node: imports) so it runs in browsers too.
//
//  0      1      2      3      4      5      6      7
// +------+------+------+------+------+------+------+------+
// | type | flags|  lane (u16)  |       length (u32)        |   payload…
// +------+------+------+------+------+------+------+------+

export const FrameType = {
  MSG: 0x00,
  END: 0x01,
  BLOB: 0x02,
  HEARTBEAT: 0x03,
  CHECKPOINT: 0x04,
  CREDIT: 0x05,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export const Flag = {
  COMPRESSED: 0x01,
  LAST: 0x02,
} as const;

export const HEADER_SIZE = 8;
export const MAX_LANE = 0xffff;
export const DEFAULT_MAX_PAYLOAD = 16 * 1024 * 1024;

export interface Frame {
  type: number;
  flags: number;
  lane: number;
  payload: Uint8Array;
}

/** Payload of an END frame. `status` uses HTTP status code semantics. */
export interface EndInfo {
  status: number;
  problem?: Problem;
  meta?: Record<string, unknown>;
}

/** RFC 9457 problem details, plus apü extension members. */
export interface Problem {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  retryable?: boolean;
  [extension: string]: unknown;
}

export class FrameError extends Error {}

const EMPTY = new Uint8Array(0);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeFrame(type: number, payload: Uint8Array = EMPTY, lane = 0, flags = 0): Uint8Array {
  if (lane < 0 || lane > MAX_LANE) throw new FrameError(`lane out of range: ${lane}`);
  const out = new Uint8Array(HEADER_SIZE + payload.byteLength);
  const view = new DataView(out.buffer);
  out[0] = type;
  out[1] = flags;
  view.setUint16(2, lane);
  view.setUint32(4, payload.byteLength);
  out.set(payload, HEADER_SIZE);
  return out;
}

// JSON is the default message encoding (research/03: V8-native JSON beats JS binary decoders).
export function encodeJson(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

export function decodeJson(payload: Uint8Array): unknown {
  return JSON.parse(textDecoder.decode(payload));
}

export function msgFrame(value: unknown, lane = 0): Uint8Array {
  return encodeFrame(FrameType.MSG, encodeJson(value), lane);
}

export function endFrame(info: EndInfo, lane = 0): Uint8Array {
  return encodeFrame(FrameType.END, encodeJson(info), lane);
}

/**
 * Incremental byte-stream → frame parser. Chunk boundaries are arbitrary (h2 DATA frames,
 * TLS records and proxies re-slice freely). Bytes are copied at most once per completed frame.
 */
export class FrameDecoder {
  readonly maxPayload: number;
  #chunks: Uint8Array[] = [];
  #length = 0;
  #need = HEADER_SIZE;

  constructor(maxPayload = DEFAULT_MAX_PAYLOAD) {
    this.maxPayload = maxPayload;
  }

  /** Number of buffered bytes that do not yet form a complete frame. */
  get pending(): number {
    return this.#length;
  }

  push(chunk: Uint8Array): Frame[] {
    if (chunk.byteLength === 0) return [];
    this.#chunks.push(chunk);
    this.#length += chunk.byteLength;
    if (this.#length < this.#need) return [];

    const buf = this.#flatten();
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const frames: Frame[] = [];
    let offset = 0;
    for (;;) {
      const available = buf.byteLength - offset;
      if (available < HEADER_SIZE) {
        this.#need = HEADER_SIZE;
        break;
      }
      const length = view.getUint32(offset + 4);
      if (length > this.maxPayload) {
        throw new FrameError(`frame payload ${length} exceeds limit ${this.maxPayload}`);
      }
      if (available < HEADER_SIZE + length) {
        this.#need = HEADER_SIZE + length;
        break;
      }
      frames.push({
        type: buf[offset]!,
        flags: buf[offset + 1]!,
        lane: view.getUint16(offset + 2),
        payload: buf.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + length),
      });
      offset += HEADER_SIZE + length;
    }
    const rest = buf.subarray(offset);
    this.#chunks = rest.byteLength > 0 ? [rest] : [];
    this.#length = rest.byteLength;
    return frames;
  }

  /** Call when the byte stream ends; throws if it ended inside a frame. */
  end(): void {
    if (this.#length > 0) throw new FrameError(`stream ended inside a frame (${this.#length} bytes pending)`);
  }

  #flatten(): Uint8Array {
    if (this.#chunks.length === 1) return this.#chunks[0]!;
    const out = new Uint8Array(this.#length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

export async function* decodeFrames(
  source: AsyncIterable<Uint8Array>,
  maxPayload = DEFAULT_MAX_PAYLOAD,
): AsyncGenerator<Frame> {
  const decoder = new FrameDecoder(maxPayload);
  for await (const chunk of source) yield* decoder.push(chunk);
  decoder.end();
}

export function frameDecoderStream(maxPayload = DEFAULT_MAX_PAYLOAD): TransformStream<Uint8Array, Frame> {
  const decoder = new FrameDecoder(maxPayload);
  return new TransformStream({
    transform(chunk, controller) {
      for (const frame of decoder.push(chunk)) controller.enqueue(frame);
    },
    flush() {
      decoder.end();
    },
  });
}

export function concatBytes(parts: readonly Uint8Array[], totalLength?: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(totalLength ?? parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
