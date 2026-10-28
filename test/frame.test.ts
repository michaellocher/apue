import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  concatBytes,
  decodeFrames,
  decodeJson,
  encodeFrame,
  FrameDecoder,
  FrameError,
  frameDecoderStream,
  FrameType,
  msgFrame,
  type Frame,
} from '../src/frame.ts';

const sample = (): Uint8Array[] => [
  msgFrame({ hello: 'wörld' }),
  encodeFrame(FrameType.HEARTBEAT),
  encodeFrame(FrameType.BLOB, new Uint8Array([0, 1, 2, 255]), 7, 0x02),
  msgFrame('x'.repeat(40_000), 3),
];

function simplify(frames: Frame[]) {
  return frames.map((f) => ({ ...f, payload: Array.from(f.payload) }));
}

describe('frame codec', () => {
  test('encodes the 8-byte header', () => {
    const bytes = encodeFrame(FrameType.END, new Uint8Array([9, 9]), 0x0102, 0x01);
    assert.deepEqual(Array.from(bytes), [1, 1, 1, 2, 0, 0, 0, 2, 9, 9]);
  });

  test('round-trips when everything arrives in one chunk', () => {
    const frames = new FrameDecoder().push(concatBytes(sample()));
    assert.equal(frames.length, 4);
    assert.deepEqual(decodeJson(frames[0]!.payload), { hello: 'wörld' });
    assert.equal(frames[1]!.type, FrameType.HEARTBEAT);
    assert.deepEqual([frames[2]!.lane, frames[2]!.flags, Array.from(frames[2]!.payload)], [7, 2, [0, 1, 2, 255]]);
    assert.equal(frames[3]!.lane, 3);
  });

  test('is independent of chunk boundaries (every split point, then byte-by-byte)', () => {
    const all = concatBytes(sample().slice(0, 3));
    const expected = simplify(new FrameDecoder().push(all));
    for (let cut = 0; cut <= all.length; cut++) {
      const decoder = new FrameDecoder();
      const got = [...decoder.push(all.subarray(0, cut)), ...decoder.push(all.subarray(cut))];
      decoder.end();
      assert.deepEqual(simplify(got), expected, `split at ${cut}`);
    }
    const decoder = new FrameDecoder();
    const got = Array.from(all).flatMap((byte) => decoder.push(new Uint8Array([byte])));
    assert.deepEqual(simplify(got), expected);
  });

  test('rejects oversized frames before buffering them', () => {
    const decoder = new FrameDecoder(1024);
    assert.throws(() => decoder.push(encodeFrame(FrameType.MSG, new Uint8Array(2048)).subarray(0, 8)), FrameError);
  });

  test('detects a stream that ends inside a frame', async () => {
    const truncated = msgFrame({ a: 1 }).subarray(0, 10);
    await assert.rejects(async () => {
      for await (const _ of decodeFrames(toAsync([truncated])));
    }, FrameError);
  });

  test('works as a WHATWG TransformStream', async () => {
    const all = concatBytes(sample());
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of [all.subarray(0, 5), all.subarray(5, 20_000), all.subarray(20_000)]) controller.enqueue(chunk);
        controller.close();
      },
    });
    const frames = await Array.fromAsync(source.pipeThrough(frameDecoderStream()));
    assert.equal(frames.length, 4);
  });
});

async function* toAsync(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  yield* chunks;
}
