// Micro-benchmarks of the per-message data path, to find where stream throughput goes.
//   node bench/micro.ts
import { decodeFrames, decodeJson, encodeFrame, encodeJson, FrameDecoder, FrameType, msgFrame } from '../src/frame.ts';
import { bench, benchAsync, table } from './lib.ts';

const small = { i: 12345, name: 'item', ok: true };
const medium = { id: 'c0ffee', name: 'customer 42', email: 'someone@example.com', tags: ['a', 'b', 'c'], total: 1234.56, address: { street: 'Main St 1', city: 'Berlin', zip: '10115' } };
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const N = 10_000;
const smallFrames = Array.from({ length: N }, () => msgFrame(small));
const stream = concat(smallFrames);
const chunks16k = split(stream, 16 * 1024);

console.log(`Node ${process.version}\n\n— encode (per message) —`);
console.log(
  table([
    bench('JSON.stringify small', () => JSON.stringify(small)),
    bench('JSON.stringify medium', () => JSON.stringify(medium)),
    bench('TextEncoder.encode small', () => textEncoder.encode('{"i":12345,"name":"item","ok":true}')),
    bench('Buffer.from(str) small', () => Buffer.from('{"i":12345,"name":"item","ok":true}')),
    bench('encodeJson small (stringify+encode)', () => encodeJson(small)),
    bench('msgFrame small (current)', () => msgFrame(small)),
    bench('msgFrame medium (current)', () => msgFrame(medium)),
    bench('frame via encodeInto (one alloc)', () => frameEncodeInto(small)),
    bench('frame via Buffer.write (one alloc)', () => frameBufferWrite(small)),
  ]),
);

console.log('\n— decode (per message) —');
const payload = encodeJson(small);
console.log(
  table([
    bench('TextDecoder.decode small', () => textDecoder.decode(payload)),
    bench('Buffer.toString small', () => Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString()),
    bench('JSON.parse small', () => JSON.parse('{"i":12345,"name":"item","ok":true}')),
    bench('decodeJson small (decode+parse)', () => decodeJson(payload)),
  ]),
);

console.log(`\n— frame parsing (${N.toLocaleString('en')} small frames in 16 KiB chunks, per frame) —`);
console.log(
  table([
    await benchAsync('FrameDecoder.push (sync)', async () => {
      const decoder = new FrameDecoder();
      let n = 0;
      for (const chunk of chunks16k) n += decoder.push(chunk).length;
      return n;
    }),
    await benchAsync('decodeFrames (async generator)', async () => {
      let n = 0;
      for await (const _ of decodeFrames(asyncChunks(chunks16k))) n++;
      return n;
    }),
    await benchAsync('decodeFrames + decodeJson', async () => {
      let n = 0;
      for await (const frame of decodeFrames(asyncChunks(chunks16k))) if (frame.type === FrameType.MSG && decodeJson(frame.payload)) n++;
      return n;
    }),
    await benchAsync('push (sync) + decodeJson', async () => {
      const decoder = new FrameDecoder();
      let n = 0;
      for (const chunk of chunks16k) for (const frame of decoder.push(chunk)) if (decodeJson(frame.payload)) n++;
      return n;
    }),
    await benchAsync('async generator yield (no work)', async () => {
      let n = 0;
      for await (const _ of counter(N)) n++;
      return n;
    }),
  ]),
);

function frameEncodeInto(value: unknown): Uint8Array {
  const json = JSON.stringify(value);
  const out = new Uint8Array(8 + json.length * 3);
  const { written } = textEncoder.encodeInto(json, out.subarray(8));
  out[0] = FrameType.MSG;
  new DataView(out.buffer).setUint32(4, written);
  return out.subarray(0, 8 + written);
}

function frameBufferWrite(value: unknown): Uint8Array {
  const json = JSON.stringify(value);
  const length = Buffer.byteLength(json);
  const out = Buffer.allocUnsafe(8 + length);
  out.writeUInt32BE(0, 0); // type 0, flags 0, lane 0
  out.writeUInt32BE(length, 4);
  out.write(json, 8);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function split(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.byteLength; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

async function* asyncChunks(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  yield* chunks;
}

async function* counter(n: number): AsyncGenerator<number> {
  for (let i = 0; i < n; i++) yield i;
}

void encodeFrame;
