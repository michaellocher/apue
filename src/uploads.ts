// Resumable uploads (draft-ietf-httpbis-resumable-upload-14, interop version 10; research/06): binary
// values are uploaded to `/$uploads` — resumably, over plain HTTP requests — and op inputs reference
// them as { "$upload": id } where the schema says t.bytes() (SPEC-DRAFT §6). Node-only.
import { createHash, randomBytes, type Hash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Exchange } from './exchange.ts';
import { concatBytes } from './frame.ts';
import { ApueError, baseMediaType, MediaType, UPLOAD_INTEROP_VERSION, UPLOADS_PATH } from './protocol.ts';

export { UPLOAD_INTEROP_VERSION, UPLOADS_PATH };
export const PARTIAL_UPLOAD = 'application/partial-upload';
const PROBLEMS = 'https://iana.org/assignments/http-problem-types';

export interface UploadOptions {
  /** Largest upload (Upload-Limit max-size). Default 64 MiB. */
  maxBytes?: number;
  /** All uploads together, complete or not; beyond it new data is refused with 503. Default 256 MiB. */
  storeBytes?: number;
  /** Lifetime of an upload resource from its creation (Upload-Limit max-age). Default 1 h. */
  ttlMs?: number;
  /**
   * Bytes one client may hold, received or announced (Upload-Length), so one client can't lock
   * out the rest. Default storeBytes / 4. Who "one client" is: see `clientKey`.
   */
  scopeBytes?: number;
  /** Upload resources one client may hold, complete or not. Default 100. */
  scopeUploads?: number;
  /**
   * Whose quota a request counts against. Default: its address — an Authorization header can't be
   * trusted here (nothing checks it), so a made-up one must not buy a fresh quota; behind a proxy
   * that is the proxy's address for everyone. Applications that authenticate can return their user id.
   */
  clientKey?: (request: { headers: IncomingHttpHeaders; remoteAddress: string | undefined }) => string;
  now?: () => number;
}

interface Upload {
  readonly id: string;
  /** Who may access it (credentials). */
  readonly scope: string;
  /** Whose quota it counts against (credentials, or the address of an anonymous client). */
  readonly quota: string;
  readonly expires: number;
  chunks: Uint8Array[];
  offset: number;
  length: number | undefined;
  complete: boolean;
  /** The request currently writing to this upload (appends abort an earlier one, §8.2/§9.2). */
  writer: { abort(): void; done: Promise<void> } | undefined;
  /** Joined once on completion. */
  bytes: Uint8Array | undefined;
  /** Announced (Upload-Length) but not yet received: already counted against the client's quota. */
  reserved: number;
  /** SHA-256 over the content in offset order, fed as data arrives; hex once complete. */
  hash: Hash;
  digest: string | undefined;
}

interface Usage {
  bytes: number;
  uploads: number;
}

export interface UploadResponse {
  status: number;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export class UploadStore {
  readonly maxBytes: number;
  readonly storeBytes: number;
  readonly ttlMs: number;
  readonly scopeBytes: number;
  readonly scopeUploads: number;
  #now: () => number;
  #uploads = new Map<string, Upload>(); // insertion order = creation order = expiry order
  #stored = 0;
  #usage = new Map<string, Usage>();

  constructor({ maxBytes = 64 * 1024 * 1024, storeBytes = 256 * 1024 * 1024, ttlMs = 60 * 60 * 1000, scopeBytes, scopeUploads = 100, now = Date.now }: UploadOptions = {}) {
    this.maxBytes = maxBytes;
    this.storeBytes = storeBytes;
    this.ttlMs = ttlMs;
    this.scopeBytes = scopeBytes ?? Math.floor(storeBytes / 4);
    this.scopeUploads = scopeUploads;
    this.#now = now;
  }

  /** Bytes held by all uploads (for tests and monitoring). */
  get storedBytes(): number {
    return this.#stored;
  }

  /** The largest upload one client can make: the per-upload and the per-client limit. */
  get maxSize(): number {
    return Math.min(this.maxBytes, this.scopeBytes);
  }

  create(scope: string, quota: string, length: number | undefined): Upload {
    this.#sweep();
    if (length !== undefined && length > this.maxSize) throw tooLarge(this.maxSize);
    const usage = this.#usageOf(quota);
    if (usage.uploads >= this.scopeUploads) throw quotaExceeded(`${this.scopeUploads} uploads`);
    // An announced length is reserved now, so parallel creations can't all pass and fail midway.
    if (length !== undefined && usage.bytes + length > this.scopeBytes) throw quotaExceeded(`${this.scopeBytes} bytes`);
    const upload: Upload = {
      id: randomBytes(16).toString('base64url'),
      scope,
      quota,
      expires: this.#now() + this.ttlMs,
      chunks: [],
      offset: 0,
      length,
      complete: false,
      writer: undefined,
      bytes: undefined,
      hash: createHash('sha256'),
      digest: undefined,
      reserved: length ?? 0,
    };
    this.#uploads.set(upload.id, upload);
    usage.uploads++;
    usage.bytes += upload.reserved;
    return upload;
  }

  /** A length announced after creation (on an append): reserve what is still to come. */
  announce(upload: Upload, length: number): void {
    if (length > this.maxSize) {
      this.delete(upload);
      throw tooLarge(this.maxSize);
    }
    const more = Math.max(0, length - upload.offset - upload.reserved);
    const usage = this.#usageOf(upload.quota);
    if (usage.bytes + more > this.scopeBytes) throw quotaExceeded(`${this.scopeBytes} bytes`);
    upload.length = length;
    upload.reserved += more;
    usage.bytes += more;
  }

  /** The upload if it exists, has not expired and belongs to `scope` — else undefined (a 404). */
  get(id: string, scope: string): Upload | undefined {
    this.#sweep();
    const upload = this.#uploads.get(id);
    return upload && upload.scope === scope ? upload : undefined;
  }

  /**
   * The complete upload's bytes for an op input reference — a copy, so a handler that changes its
   * input can't corrupt later references or replays — and its SHA-256 (the reference's identity
   * for idempotency: the same content uploaded again is the same input). Undefined if not usable.
   */
  resolve(id: string, scope: string): { bytes: Uint8Array; digest: string } | undefined {
    const upload = this.get(id, scope);
    if (!upload?.complete) return undefined;
    upload.bytes ??= concatBytes(upload.chunks, upload.offset);
    upload.chunks = [upload.bytes];
    return { bytes: upload.bytes.slice(), digest: upload.digest! };
  }

  append(upload: Upload, chunk: Uint8Array): void {
    // Deleted meanwhile (DELETE, expiry): counting its bytes would recreate a usage entry nothing frees.
    if (this.#uploads.get(upload.id) !== upload) throw notFound();
    if (upload.length !== undefined && upload.offset + chunk.byteLength > upload.length) {
      this.delete(upload);
      throw inconsistentLength(`content beyond Upload-Length ${upload.length}`);
    }
    // Beyond what one client may ever hold, the content is too large (413) — not a quota to free (507).
    if (upload.offset + chunk.byteLength > this.maxSize) {
      this.delete(upload);
      throw tooLarge(this.maxSize);
    }
    const usage = this.#usageOf(upload.quota);
    const covered = Math.min(chunk.byteLength, upload.reserved); // already counted when announced
    const extra = chunk.byteLength - covered;
    if (usage.bytes + extra > this.scopeBytes) throw quotaExceeded(`${this.scopeBytes} bytes`);
    if (this.#stored + chunk.byteLength > this.storeBytes) {
      throw new ApueError(503, 'Service Unavailable', 'upload storage is full', { retryable: true }, { 'retry-after': '60' });
    }
    upload.chunks.push(chunk);
    upload.hash.update(chunk);
    upload.offset += chunk.byteLength;
    upload.reserved -= covered;
    this.#stored += chunk.byteLength;
    usage.bytes += extra;
  }

  /** Marks the upload complete: its content and digest are final. */
  seal(upload: Upload): void {
    upload.complete = true;
    upload.length = upload.offset;
    upload.digest ??= upload.hash.digest('hex');
  }

  delete(upload: Upload): void {
    if (this.#uploads.get(upload.id) !== upload) return;
    this.#uploads.delete(upload.id);
    this.#stored -= upload.offset;
    const usage = this.#usageOf(upload.quota);
    usage.bytes -= upload.offset + upload.reserved;
    if (--usage.uploads === 0) this.#usage.delete(upload.quota);
    upload.writer?.abort();
  }

  #usageOf(scope: string): Usage {
    let usage = this.#usage.get(scope);
    if (!usage) this.#usage.set(scope, (usage = { bytes: 0, uploads: 0 }));
    return usage;
  }

  limits(upload?: Upload): string {
    const maxAge = Math.max(0, Math.ceil(((upload?.expires ?? this.#now() + this.ttlMs) - this.#now()) / 1000));
    return `max-size=${this.maxSize}, max-age=${maxAge}`;
  }

  #sweep(): void {
    const now = this.#now();
    for (const upload of this.#uploads.values()) {
      if (upload.expires > now) break;
      this.delete(upload);
    }
  }
}

/**
 * Serves `/$uploads` (creation, OPTIONS) and `/$uploads/{id}` (HEAD/GET offset, PATCH append,
 * DELETE). `scope` identifies the credentials (uploads are invisible to other principals).
 */
export async function handleUpload(req: Exchange, store: UploadStore, scope: string, quota: string, path: string): Promise<UploadResponse> {
  const id = path === UPLOADS_PATH ? undefined : path.slice(UPLOADS_PATH.length + 1);
  if (id === undefined) {
    if (req.method === 'OPTIONS') return { status: 204, headers: { 'upload-limit': store.limits(), allow: 'OPTIONS, POST' } };
    if (req.method !== 'POST') throw notAllowed('OPTIONS, POST');
    return create(req, store, scope, quota);
  }
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) throw notFound();
  const upload = store.get(id, scope);
  switch (req.method) {
    case 'HEAD':
    case 'GET': {
      if (!upload) throw notFound();
      return { status: 204, headers: { ...state(store, upload), 'cache-control': 'no-store' } };
    }
    case 'PATCH':
      if (!upload) throw notFound();
      return append(req, store, upload);
    case 'DELETE': {
      if (!upload) throw notFound();
      store.delete(upload);
      await upload.writer?.done;
      return { status: 204, headers: {} };
    }
    default:
      throw notAllowed('DELETE, GET, HEAD, PATCH');
  }
}

async function create(req: Exchange, store: UploadStore, scope: string, quota: string): Promise<UploadResponse> {
  // Without Upload-Complete this is a plain (non-resumable) upload of the whole content.
  const complete = parseBoolean(req.headers['upload-complete'], 'Upload-Complete') ?? true;
  const length = parseInteger(req.headers['upload-length'], 'Upload-Length');
  const upload = store.create(scope, quota, length);
  const location = `${UPLOADS_PATH}/${upload.id}`;
  if (req.headers['upload-draft-interop-version'] === UPLOAD_INTEROP_VERSION) {
    req.interim?.(104, { location, 'upload-limit': store.limits(upload), 'upload-draft-interop-version': UPLOAD_INTEROP_VERSION });
  }
  await receive(req, store, upload);
  if (complete) return finish(store, upload, location);
  return { status: 201, headers: { location, ...state(store, upload) } };
}

async function append(req: Exchange, store: UploadStore, upload: Upload): Promise<UploadResponse> {
  if (baseMediaType(req.headers['content-type'] as string | undefined) !== PARTIAL_UPLOAD) {
    throw new ApueError(415, 'Unsupported Media Type', `appends need Content-Type: ${PARTIAL_UPLOAD}`);
  }
  const offset = parseInteger(req.headers['upload-offset'], 'Upload-Offset');
  const complete = parseBoolean(req.headers['upload-complete'], 'Upload-Complete');
  if (offset === undefined || complete === undefined) throw new ApueError(400, 'Bad Request', 'appends need Upload-Offset and Upload-Complete');
  // A newer append wins over one still in flight (its connection may be dead but not yet noticed).
  // Loop: another request may have taken over while we waited; and the upload may be gone.
  while (upload.writer) {
    upload.writer.abort();
    await upload.writer.done;
  }
  if (store.get(upload.id, upload.scope) !== upload) throw notFound();
  const location = `${UPLOADS_PATH}/${upload.id}`;
  if (upload.complete) {
    // Replay the final response for a repeated, empty completing append (§8.2). Emptiness is judged
    // by the content itself: HTTP/2 requests need not carry Content-Length.
    if (offset !== upload.offset || !complete) throw mismatch(upload, offset, store);
    for await (const chunk of req) {
      if (chunk.byteLength > 0) throw new ApueError(409, 'Conflict', 'the upload is already complete', {}, state(store, upload));
    }
    return finish(store, upload, location);
  }
  if (offset !== upload.offset) throw mismatch(upload, offset, store);
  const length = parseInteger(req.headers['upload-length'], 'Upload-Length');
  if (length !== undefined) {
    if (upload.length !== undefined && length !== upload.length) {
      store.delete(upload);
      throw inconsistentLength(`Upload-Length ${length} differs from ${upload.length}`);
    }
    store.announce(upload, length);
  }
  await receive(req, store, upload);
  if (complete) return finish(store, upload, location);
  return { status: 204, headers: state(store, upload) };
}

/** Appends the request content as it arrives, so an interrupted request keeps what came through. */
async function receive(req: Exchange, store: UploadStore, upload: Upload): Promise<void> {
  // Aborting must not wait for the next chunk: a superseded request's connection may be dead.
  let abort!: () => void;
  const aborted = new Promise<'aborted'>((resolve) => (abort = () => resolve('aborted')));
  let settle!: () => void;
  const writer = { abort, done: new Promise<void>((resolve) => (settle = resolve)) };
  upload.writer = writer;
  const chunks = req[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await Promise.race([chunks.next(), aborted]);
      if (next === 'aborted') {
        void chunks.return?.()?.catch(() => {});
        throw new ApueError(409, 'Conflict', 'superseded by a newer request to this upload (or cancelled)');
      }
      if (next.done) break;
      store.append(upload, new Uint8Array(next.value));
    }
  } catch (error) {
    if (error instanceof ApueError) throw error;
    // The client went away mid-content: what arrived stays, the client resumes from Upload-Offset.
    throw new ApueError(499, 'Client Closed Request', 'upload interrupted');
  } finally {
    if (upload.writer === writer) upload.writer = undefined;
    settle();
  }
}

function finish(store: UploadStore, upload: Upload, location: string): UploadResponse {
  if (upload.length !== undefined && upload.offset !== upload.length) {
    store.delete(upload);
    throw inconsistentLength(`completed at ${upload.offset} bytes, Upload-Length was ${upload.length}`);
  }
  store.seal(upload);
  // The target resource's response (§8.2): a reference for op inputs.
  const body = new TextEncoder().encode(JSON.stringify({ upload: upload.id, size: upload.offset }));
  return { status: 201, headers: { location, 'upload-complete': '?1', 'content-type': MediaType.JSON, 'cache-control': 'no-store' }, body };
}

function state(store: UploadStore, upload: Upload): Record<string, string> {
  return {
    'upload-offset': String(upload.offset),
    'upload-complete': upload.complete ? '?1' : '?0',
    'upload-limit': store.limits(upload),
    ...(upload.length === undefined ? {} : { 'upload-length': String(upload.length) }),
  };
}

function mismatch(upload: Upload, provided: number, store: UploadStore): ApueError {
  return new ApueError(
    409,
    'Conflict',
    `Upload-Offset ${provided} does not match ${upload.offset}`,
    { type: `${PROBLEMS}#mismatching-upload-offset`, 'expected-offset': upload.offset, 'provided-offset': provided },
    { ...state(store, upload), 'upload-complete': '?0' },
  );
}

const inconsistentLength = (detail: string) => new ApueError(400, 'Bad Request', detail, { type: `${PROBLEMS}#inconsistent-upload-length` });
const tooLarge = (max: number) => new ApueError(413, 'Content Too Large', `uploads are limited to ${max} bytes`);
const notFound = () => new ApueError(404, 'Not Found', 'no such upload (unknown, expired or not yours)');
const notAllowed = (allow: string) => new ApueError(405, 'Method Not Allowed', undefined, {}, { allow });
// 507 (Insufficient Storage, RFC 4918 §11.5), not 429: retrying soon won't help; deleting uploads will.
const quotaExceeded = (what: string) =>
  new ApueError(507, 'Insufficient Storage', `this client's uploads are limited to ${what}; finished uploads expire or can be deleted`);

function parseBoolean(value: string | string[] | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === '?1') return true;
  if (value === '?0') return false;
  throw new ApueError(400, 'Bad Request', `${name} must be ?0 or ?1`);
}

/** SF Integer, non-negative (RFC 9651 §3.3.1: at most 15 digits). */
function parseInteger(value: string | string[] | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) throw new ApueError(400, 'Bad Request', `${name} must be a non-negative integer`);
  return Number(value);
}

