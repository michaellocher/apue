// Binary payloads inside framed streams (SPEC-DRAFT §6): each Uint8Array in a message is sent as
// raw BLOB frames on the message's lane *before* the MSG frame, chunked, the last chunk flagged.
// The message references them in order as {"$blob": k}. Look-alike data ({"$blob"}/{"$lit"} as
// the only member) is escaped as {"$lit": value}. Web-only.
import { encodeFrame, Flag, FrameError, FrameType, jsonFrame, type Frame } from './frame.ts';

export const BLOB_CHUNK = 64 * 1024;

function soleKey(value: object): string | undefined {
  const keys = Object.keys(value);
  return keys.length === 1 ? keys[0] : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function extract(value: unknown, blobs: Uint8Array[]): unknown {
  if (value instanceof Uint8Array) {
    blobs.push(value);
    return { $blob: blobs.length - 1 };
  }
  if (Array.isArray(value)) return value.map((item) => extract(item, blobs));
  if (!isPlainObject(value)) return value;
  const key = soleKey(value);
  if (key === '$blob' || key === '$lit') return { $lit: value };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = extract(v, blobs);
  return out;
}

/** Splits a message into its JSON part (with {"$blob": k} references) and the blobs. */
export function splitMessage(value: unknown): { json: unknown; blobs: Uint8Array[] } {
  const blobs: Uint8Array[] = [];
  return { json: extract(value, blobs), blobs };
}

/** BLOB frame payloads for one blob: chunks of at most chunkSize, the last one flagged. */
export function* blobChunks(blob: Uint8Array, chunkSize = BLOB_CHUNK): Generator<{ chunk: Uint8Array; flags: number }> {
  if (blob.byteLength === 0) return yield { chunk: blob, flags: Flag.LAST };
  for (let offset = 0; offset < blob.byteLength; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, blob.byteLength);
    yield { chunk: blob.subarray(offset, end), flags: end === blob.byteLength ? Flag.LAST : 0 };
  }
}

/** Frames for one message: BLOB chunks for every Uint8Array it contains, then the MSG frame. */
export function messageFrames(value: unknown, lane = 0, chunkSize = BLOB_CHUNK): Uint8Array[] {
  const { json, blobs } = splitMessage(value);
  const frames: Uint8Array[] = [];
  for (const blob of blobs) {
    for (const { chunk, flags } of blobChunks(blob, chunkSize)) frames.push(encodeFrame(FrameType.BLOB, chunk, lane, flags));
  }
  frames.push(jsonFrame(FrameType.MSG, json, lane));
  return frames;
}

/** Collects BLOB frames per lane and resolves {"$blob": k} references of the next MSG. */
export class BlobAssembler {
  readonly maxBytes: number;
  #lanes = new Map<number, { done: Uint8Array[]; chunks: Uint8Array[]; size: number; total: number }>();

  constructor(maxBytes = 64 * 1024 * 1024) {
    this.maxBytes = maxBytes;
  }

  /** Call for every BLOB frame. */
  push(frame: Frame): void {
    let lane = this.#lanes.get(frame.lane);
    if (!lane) this.#lanes.set(frame.lane, (lane = { done: [], chunks: [], size: 0, total: 0 }));
    lane.total += frame.payload.byteLength;
    if (lane.total > this.maxBytes) throw new FrameError(`blobs for one message exceed ${this.maxBytes} bytes`, 'too-large');
    lane.chunks.push(frame.payload.slice()); // copy: the decoder's buffer is reused
    lane.size += frame.payload.byteLength;
    if (frame.flags & Flag.LAST) {
      lane.done.push(concat(lane.chunks, lane.size));
      lane.chunks = [];
      lane.size = 0;
    }
  }

  /** Resolves a decoded MSG value on `lane`; consumes the blobs received for it. */
  resolve(value: unknown, lane = 0): unknown {
    const state = this.#lanes.get(lane);
    if (state && state.chunks.length > 0) throw new FrameError('MSG frame arrived inside an unfinished blob');
    const blobs = state?.done ?? [];
    this.#lanes.delete(lane);
    const used = new Set<number>();
    const result = restore(value, blobs, used);
    if (used.size !== blobs.length) throw new FrameError(`message references ${used.size} of ${blobs.length} blobs`);
    return result;
  }
}

function restore(value: unknown, blobs: Uint8Array[], used: Set<number>): unknown {
  if (Array.isArray(value)) return value.map((item) => restore(item, blobs, used));
  if (value === null || typeof value !== 'object') return value;
  const key = soleKey(value);
  if (key === '$lit') return (value as { $lit: unknown }).$lit;
  if (key === '$blob') {
    const index = (value as { $blob: unknown }).$blob;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= blobs.length || used.has(index as number)) {
      throw new FrameError(`invalid blob reference ${JSON.stringify(index)}`);
    }
    used.add(index as number);
    return blobs[index as number];
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = restore(v, blobs, used);
  return out;
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
