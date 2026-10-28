// Client side of t.download() outputs (research/11 §3): the reference in an output becomes a
// Download — its URL works as a plain link (<a download>, <video src>) until it expires, and
// stream() resumes a lost connection with Range + If-Range instead of starting over. Web-safe.
import type { Transport } from './client.ts';
import { concatBytes, type Problem } from './frame.ts';
import { ApueError } from './protocol.ts';
import type { DownloadRef } from './schema.ts';

export interface DownloadContext {
  transport: Transport;
  retries: number;
  backoffMs: number;
}

export class Download {
  /** Path of the download resource on the API's origin. */
  readonly path: string;
  /** Absolute URL when the transport knows its base URL (else the path). */
  readonly url: string;
  readonly size: number;
  readonly type: string;
  /** SHA-256 of the content, hex, if the server knows it (bytes() and Node's stream() verify it). */
  readonly sha256: string | undefined;
  readonly expires: Date;
  #context: DownloadContext;

  constructor(ref: DownloadRef, context: DownloadContext) {
    this.path = ref.$download;
    this.url = context.transport.baseUrl ? new URL(ref.$download, context.transport.baseUrl).href : ref.$download;
    this.size = ref.size;
    this.type = ref.type;
    this.sha256 = ref.sha256;
    this.expires = new Date(ref.expires);
    this.#context = context;
  }

  /**
   * The content as it arrives. A lost connection is resumed where it stopped (Range + If-Range,
   * within the client's retry budget); a different representation behind the URL is an error.
   * In Node the SHA-256 is verified at the end.
   */
  async *stream(options: { signal?: AbortSignal } = {}): AsyncGenerator<Uint8Array> {
    const { transport, retries, backoffMs } = this.#context;
    const signal = options.signal ?? new AbortController().signal;
    const hash = this.sha256 === undefined ? undefined : await nodeHash();
    let received = 0;
    let etag: string | undefined;
    let failures = 0;
    const retry = async (error: unknown) => {
      if (signal.aborted) throw signal.reason;
      if (error instanceof ApueError || ++failures > retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.random() * backoffMs * 2 ** failures));
    };
    for (;;) {
      signal.throwIfAborted();
      const headers: Record<string, string> = received === 0 ? {} : { range: `bytes=${received}-`, ...(etag ? { 'if-range': etag } : {}) };
      let res;
      try {
        res = await transport.request({ method: 'GET', path: this.path, headers, signal });
      } catch (error) {
        await retry(error);
        continue;
      }
      let skip = 0;
      if (res.status >= 400) throw await problem(res.status, res.body);
      if (received === 0) {
        if (res.status !== 200) throw new ApueError(502, 'Bad Gateway', `download answered ${res.status}`);
        etag = res.headers.get('etag') ?? undefined;
      } else if (res.status === 206) {
        if (!res.headers.get('content-range')?.startsWith(`bytes ${received}-`)) throw new ApueError(502, 'Bad Gateway', 'download resumed at the wrong offset');
      } else if (res.status === 200 && etag !== undefined && res.headers.get('etag') === etag) {
        skip = received; // the same content, sent whole: skip what we have
      } else {
        throw new ApueError(502, 'Bad Gateway', 'the download changed while resuming');
      }
      try {
        for await (let chunk of res.body) {
          if (skip > 0) {
            if (chunk.byteLength <= skip) {
              skip -= chunk.byteLength;
              continue;
            }
            chunk = chunk.subarray(skip);
            skip = 0;
          }
          if (received + chunk.byteLength > this.size) throw new ApueError(502, 'Bad Gateway', `download larger than its announced ${this.size} bytes`);
          received += chunk.byteLength;
          hash?.update(chunk);
          yield chunk;
        }
      } catch (error) {
        await retry(error);
        continue;
      }
      if (received === this.size) break;
      await retry(new Error(`download ended after ${received} of ${this.size} bytes`)); // truncated: resume
    }
    if (hash && hash.digest('hex') !== this.sha256) throw new ApueError(502, 'Bad Gateway', 'download content does not match its SHA-256');
  }

  /** The whole content in memory, SHA-256 verified (WebCrypto) when the server announced one. */
  async bytes(options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of this.stream(options)) chunks.push(chunk);
    const bytes = concatBytes(chunks, this.size);
    if (this.sha256 !== undefined) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
      const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
      if (hex !== this.sha256) throw new ApueError(502, 'Bad Gateway', 'download content does not match its SHA-256');
    }
    return bytes;
  }

  /** The content as a Blob (browsers may keep it on disk). Verified in Node only (see stream()). */
  async blob(options: { signal?: AbortSignal } = {}): Promise<Blob> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of this.stream(options)) chunks.push(chunk);
    return new Blob(chunks as BlobPart[], { type: this.type });
  }
}

/** Incremental SHA-256 where available (Node); WebCrypto has none. */
async function nodeHash(): Promise<{ update(chunk: Uint8Array): void; digest(encoding: 'hex'): string } | undefined> {
  if (typeof process === 'undefined' || !process.versions?.node) return undefined;
  const { createHash } = await import('node:crypto');
  return createHash('sha256');
}

async function problem(status: number, body: AsyncIterable<Uint8Array>): Promise<ApueError> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  let parsed: Partial<Problem> | undefined;
  try {
    parsed = JSON.parse(new TextDecoder().decode(concatBytes(chunks, chunks.reduce((n, c) => n + c.byteLength, 0))));
  } catch {
    parsed = undefined;
  }
  return ApueError.fromProblem(parsed, status);
}
