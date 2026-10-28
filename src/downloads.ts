// Download resources for t.download() outputs (research/11 §3): a handler returns a DownloadSource,
// the server registers it under an unguessable, short-lived URL `/$downloads/{id}` and puts a
// reference into the output. The URL is plain HTTP — Range (RFC 9110 §14), If-Range, a strong ETag,
// Repr-Digest (RFC 9530) — so a lost connection resumes where it stopped and browsers can use it as a
// link (<a download>, <video src>). The URL is the capability, like a presigned URL: a link can't
// carry Authorization. Node-only.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Exchange } from './exchange.ts';
import { drained } from './node-streams.ts';
import { ApueError, DOWNLOADS_PATH } from './protocol.ts';
import type { DownloadRef, DownloadSource } from './schema.ts';

export { DOWNLOADS_PATH };
const CHUNK = 64 * 1024;

export interface DownloadOptions {
  /** How long a download URL works after the call that created it. Default 15 min. */
  ttlMs?: number;
  /** Download resources held at once (oldest dropped first). Default 10,000. */
  maxEntries?: number;
  /** Prefix of download ids (`<instance>.<random>`) for routing by replica; set by the server's `instance` option. */
  instance?: string;
}

/** Ready-made sources for t.download() outputs. */
export const download = {
  /**
   * A file. Its size and modification time are taken now; if the file changes while the URL is in
   * use, requests fail instead of serving mixed content.
   */
  async fromFile(path: string, options: { type?: string; filename?: string; sha256?: string } = {}): Promise<DownloadSource> {
    const before = await stat(path);
    return {
      size: before.size,
      ...options,
      async *open(range) {
        const now = await stat(path);
        if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) throw new Error(`${path} changed after it was offered for download`);
        yield* createReadStream(path, range ?? {}) as AsyncIterable<Uint8Array>;
      },
    };
  },

  /** Bytes in memory (copied: later changes to the caller's buffer don't reach the download). */
  fromBytes(bytes: Uint8Array, options: { type?: string; filename?: string } = {}): DownloadSource {
    const content = bytes.slice();
    return {
      size: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
      ...options,
      async *open(range) {
        const end = range ? range.end + 1 : content.byteLength;
        for (let offset = range?.start ?? 0; offset < end; offset += CHUNK) yield content.subarray(offset, Math.min(end, offset + CHUNK));
      },
    };
  },
};

interface Entry {
  source: DownloadSource;
  expires: number;
  etag: string;
}

export class DownloadStore {
  readonly ttlMs: number;
  readonly maxEntries: number;
  #entries = new Map<string, Entry>(); // insertion order = expiry order
  #now: () => number;

  #prefix: string;

  constructor({ ttlMs = 15 * 60 * 1000, maxEntries = 10_000, instance }: DownloadOptions = {}, now: () => number = Date.now) {
    for (const [name, value] of Object.entries({ ttlMs, maxEntries })) {
      if (!(Number.isSafeInteger(value) && value > 0)) throw new RangeError(`downloads.${name} must be a positive integer, got ${value}`);
    }
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.#prefix = instance === undefined ? '' : `${instance}.`;
    this.#now = now;
  }

  /** Registers a source and returns the reference that goes into the output. */
  register(source: DownloadSource): DownloadRef {
    this.#sweep();
    if (this.#entries.size >= this.maxEntries) this.#entries.delete(this.#entries.keys().next().value!);
    const id = `${this.#prefix}${randomBytes(16).toString('base64url')}`;
    const expires = this.#now() + this.ttlMs;
    this.#entries.set(id, { source, expires, etag: `"${id}"` });
    return {
      $download: `${DOWNLOADS_PATH}/${id}`,
      size: source.size,
      type: source.type ?? 'application/octet-stream',
      ...(source.sha256 === undefined ? {} : { sha256: source.sha256 }),
      expires: new Date(expires).toISOString(),
    };
  }

  /**
   * For an Idempotency-Key replay: the reference again with a fresh expiry, if its download is
   * still registered — undefined once it is gone (the stored response can't revive it).
   */
  refresh(ref: DownloadRef): DownloadRef | undefined {
    const id = ref.$download.slice(DOWNLOADS_PATH.length + 1);
    const entry = this.get(id);
    if (!entry) return undefined;
    entry.expires = this.#now() + this.ttlMs;
    this.#entries.delete(id); // re-inserted last: insertion order stays expiry order
    this.#entries.set(id, entry);
    return { ...ref, expires: new Date(entry.expires).toISOString() };
  }

  get(id: string): Entry | undefined {
    this.#sweep();
    return this.#entries.get(id);
  }

  #sweep(): void {
    const now = this.#now();
    for (const [id, entry] of this.#entries) {
      if (entry.expires > now) break;
      this.#entries.delete(id);
    }
  }

  /** Seconds until the entry expires (for Cache-Control). */
  remaining(entry: Entry): number {
    return Math.max(0, Math.floor((entry.expires - this.#now()) / 1000));
  }
}

type Range = { start: number; end: number } | 'unsatisfiable' | undefined;

/**
 * RFC 9110 §14.1.2: a single `bytes=a-b`, `bytes=a-` or `bytes=-n`. Several ranges or invalid
 * syntax are ignored (a server MAY ignore Range) — the whole content is sent.
 */
export function parseRange(header: string | undefined, size: number): Range {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return undefined;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  if (match[2] !== '' && Number(match[2]) < start) return undefined; // last before first: invalid, ignored
  if (start >= size) return 'unsatisfiable';
  return { start, end: match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1) };
}

/** `filename*` (RFC 6266 §4.3, RFC 8187) plus an ASCII fallback. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** GET/HEAD /$downloads/{id}. */
export async function serveDownload(req: Exchange, res: Exchange, store: DownloadStore, path: string, gone: AbortSignal): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new ApueError(405, 'Method Not Allowed', `${req.method} is not allowed on downloads`, {}, { allow: 'GET, HEAD' });
  }
  const entry = store.get(path.slice(DOWNLOADS_PATH.length + 1));
  if (!entry) throw new ApueError(404, 'Not Found', 'unknown or expired download (call the operation again for a fresh URL)');
  const { source, etag } = entry;
  const headers: Record<string, string> = {
    'accept-ranges': 'bytes',
    etag,
    'content-type': source.type ?? 'application/octet-stream',
    // The URL is a capability: never in shared caches; immutable while it lives.
    'cache-control': `private, max-age=${store.remaining(entry)}, immutable`,
    ...(source.filename === undefined ? {} : { 'content-disposition': contentDisposition(source.filename) }),
    ...(source.sha256 === undefined ? {} : { 'repr-digest': `sha-256=:${Buffer.from(source.sha256, 'hex').toString('base64')}:` }),
  };
  const inm = req.headers['if-none-match'];
  if (typeof inm === 'string' && inm.split(',').some((tag) => tag.trim() === etag || tag.trim() === '*')) return res.send(304, headers);
  // If-Range: the range only applies to the same representation (strong comparison, §13.1.5).
  const ifRange = req.headers['if-range'];
  const range = ifRange === undefined || ifRange === etag ? parseRange(req.headers.range as string | undefined, source.size) : undefined;
  if (range === 'unsatisfiable') {
    return res.send(416, { ...headers, 'content-range': `bytes */${source.size}` });
  }
  const status = range ? 206 : 200;
  const length = range ? range.end - range.start + 1 : source.size;
  const responseHeaders = { ...headers, 'content-length': String(length), ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${source.size}` } : {}) };
  if (req.method === 'HEAD' || length === 0) return res.send(status, responseHeaders);
  const content = source.open(range ?? { start: 0, end: source.size - 1 })[Symbol.asyncIterator]();
  // The first chunk before the headers: a source that fails at once (a changed file) is a 500,
  // not a truncated 200.
  let next = await content.next();
  res.writeHead(status, responseHeaders);
  const sink = res.sink;
  let sent = 0;
  try {
    for (; !next.done; next = await content.next()) {
      if (gone.aborted) return;
      sent += next.value.byteLength;
      if (sent > length) throw new Error('download source produced more bytes than its size');
      if (!sink.write(next.value)) await drained(sink);
    }
    if (sent !== length) throw new Error(`download source produced ${sent} of ${length} bytes`);
  } catch (error) {
    // After the headers a failure must not look like a complete (short) response: reset the
    // stream (HTTP/2 RST_STREAM, HTTP/1.1 connection) so the client resumes or fails.
    sink.destroy();
    throw error;
  } finally {
    if (!next.done) await content.return?.();
  }
  res.end();
}
