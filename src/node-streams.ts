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

/**
 * Largest single write. node:http2 counts data queued for a stream against the session's memory
 * limit (maxSessionMemory, 10 MB by default) — and kept counting a large write after its stream had
 * died, refusing every new stream on the connection (ENHANCE_YOUR_CALM; a cut 32 MiB upload, S30).
 * Writes in slices keep at most about one slice queued.
 */
export const WRITE_SLICE = 1024 * 1024;

/** Writes all chunks of `source` into `sink` in slices, honouring backpressure, then ends it. */
export async function pump(source: AsyncIterable<Uint8Array>, sink: Writable): Promise<void> {
  try {
    for await (const chunk of source) {
      for (let offset = 0; offset === 0 || offset < chunk.byteLength; offset += WRITE_SLICE) {
        if (sink.destroyed) return;
        const slice = chunk.byteLength <= WRITE_SLICE ? chunk : chunk.subarray(offset, offset + WRITE_SLICE);
        if (!sink.write(slice)) await drained(sink);
      }
    }
    sink.end();
  } catch (error) {
    sink.destroy(error as Error);
  }
}
