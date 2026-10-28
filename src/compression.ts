// Content-coding negotiation and (de)compression (SPEC-DRAFT §12). Node-only.
//
// Defaults from measurements on JSON API payloads (bench S4, Node 26.12.1): zstd-3 15.7× at
// ~250 MiB/s, brotli-4 16.7× at ~160 MiB/s, gzip-1 6.6× at ~640 MiB/s (gzip-6: 6.8×, ~150 MiB/s).
// brotli-11 runs at ~1 MiB/s — never for dynamic content.
import zlib from 'node:zlib';
import type { Transform } from 'node:stream';

export type Coding = 'zstd' | 'br' | 'gzip';

export const DEFAULT_CODINGS: readonly Coding[] = ['zstd', 'br', 'gzip'];

/**
 * Picks a content-coding from Accept-Encoding (RFC 9110 §12.5.3): highest q wins, ties go to the
 * server's preference order; q=0 excludes; `*` covers codings not listed. Undefined = identity.
 */
export function negotiate(acceptEncoding: string | undefined, supported: readonly Coding[] = DEFAULT_CODINGS): Coding | undefined {
  if (!acceptEncoding) return undefined;
  const weights = new Map<string, number>();
  for (const part of acceptEncoding.split(',')) {
    const [token, ...params] = part.trim().toLowerCase().split(';');
    if (!token) continue;
    let q = 1;
    for (const param of params) {
      const [name, value] = param.trim().split('=');
      if (name === 'q') q = Number(value);
    }
    if (Number.isFinite(q) && q >= 0 && q <= 1) weights.set(token, q);
  }
  let best: Coding | undefined;
  let bestQ = 0;
  for (const coding of supported) {
    const q = weights.get(coding) ?? weights.get('*') ?? 0;
    if (q > bestQ) {
      best = coding;
      bestQ = q;
    }
  }
  return best;
}

const BROTLI_PARAMS = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } };
const GZIP_OPTIONS = { level: 1 };

export function compressSync(coding: Coding, body: Uint8Array): Buffer {
  if (coding === 'zstd') return zlib.zstdCompressSync(body);
  if (coding === 'br') return zlib.brotliCompressSync(body, { ...BROTLI_PARAMS, params: { ...BROTLI_PARAMS.params, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength } });
  return zlib.gzipSync(body, GZIP_OPTIONS);
}

/** Off the event loop (libuv thread pool) — for large bodies. */
export function compressAsync(coding: Coding, body: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, result: Buffer) => (error ? reject(error) : resolve(result));
    if (coding === 'zstd') zlib.zstdCompress(body, done);
    else if (coding === 'br') zlib.brotliCompress(body, BROTLI_PARAMS, done);
    else zlib.gzip(body, GZIP_OPTIONS, done);
  });
}

export function createCompressor(coding: Coding): Transform {
  if (coding === 'zstd') return zlib.createZstdCompress();
  if (coding === 'br') return zlib.createBrotliCompress(BROTLI_PARAMS);
  return zlib.createGzip(GZIP_OPTIONS);
}

/** Emits everything written so far as a decodable unit (per-frame-burst flush keeps TTFB low). */
export function flushCompressor(compressor: Transform, coding: Coding): void {
  const flushable = compressor as Transform & { flush(kind?: number, callback?: () => void): void };
  if (coding === 'zstd') flushable.flush(zlib.constants.ZSTD_e_flush);
  else if (coding === 'br') flushable.flush(zlib.constants.BROTLI_OPERATION_FLUSH);
  else flushable.flush(zlib.constants.Z_SYNC_FLUSH);
}

export function createDecompressor(coding: string): Transform | undefined {
  if (coding === 'zstd') return zlib.createZstdDecompress();
  if (coding === 'br') return zlib.createBrotliDecompress();
  if (coding === 'gzip' || coding === 'x-gzip') return zlib.createGunzip();
  if (coding === 'deflate') return zlib.createInflate();
  return undefined;
}
