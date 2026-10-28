// Node-only stream helpers shared by server and http2 transport.
import type { Writable } from 'node:stream';

/** Resolves when `sink` can take more data again, or when it closes/errors (never hangs). */
export function drained(sink: Writable): Promise<void> {
  if (!sink.writableNeedDrain || sink.destroyed === true || sink.writableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      sink.off('drain', done);
      sink.off('close', done);
      sink.off('error', done);
      resolve();
    };
    sink.on('drain', done);
    sink.on('close', done);
    sink.on('error', done);
  });
}

/** Writes all chunks of `source` into `sink`, honouring backpressure, then ends it. */
export async function pump(source: AsyncIterable<Uint8Array>, sink: Writable): Promise<void> {
  try {
    for await (const chunk of source) {
      if (sink.destroyed) return;
      if (!sink.write(chunk)) await drained(sink);
    }
    sink.end();
  } catch (error) {
    sink.destroy(error as Error);
  }
}
