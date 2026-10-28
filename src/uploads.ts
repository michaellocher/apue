// Resumable uploads (draft-ietf-httpbis-resumable-upload-14, interop version 10; research/06): binary
// values are uploaded to `/$uploads` — resumably, over plain HTTP requests — and op inputs reference
// them as { "$upload": id } where the schema says t.bytes() (SPEC-DRAFT §6). Node-only.
import { randomBytes } from 'node:crypto';
import type { Exchange } from './exchange.ts';
import { ApueError, MediaType } from './protocol.ts';

export const UPLOADS_PATH = '/$uploads';
export const UPLOAD_INTEROP_VERSION = '10';
export const PARTIAL_UPLOAD = 'application/partial-upload';
const PROBLEMS = 'https://iana.org/assignments/http-problem-types';

export interface UploadOptions {
  /** Largest upload (Upload-Limit max-size). Default 64 MiB. */
  maxBytes?: number;
  /** All uploads together, complete or not; beyond it new data is refused with 503. Default 256 MiB. */
  storeBytes?: number;
  /** Lifetime of an upload resource from its creation (Upload-Limit max-age). Default 1 h. */
  ttlMs?: number;
  now?: () => number;
}

interface Upload {
  readonly id: string;
  readonly scope: string;
  readonly expires: number;
  chunks: Uint8Array[];
  offset: number;
  length: number | undefined;
  complete: boolean;
  /** The request currently writing to this upload (appends abort an earlier one, §8.2/§9.2). */
  writer: { abort(): void; done: Promise<void> } | undefined;
  /** Joined once on completion. */
  bytes: Uint8Array | undefined;
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
  #now: () => number;
  #uploads = new Map<string, Upload>(); // insertion order = creation order = expiry order
  #stored = 0;

  constructor({ maxBytes = 64 * 1024 * 1024, storeBytes = 256 * 1024 * 1024, ttlMs = 60 * 60 * 1000, now = Date.now }: UploadOptions = {}) {
    this.maxBytes = maxBytes;
    this.storeBytes = storeBytes;
    this.ttlMs = ttlMs;
    this.#now = now;
  }

  /** Bytes held by all uploads (for tests and monitoring). */
  get storedBytes(): number {
    return this.#stored;
  }

  create(scope: string, length: number | undefined): Upload {
    this.#sweep();
    if (length !== undefined && length > this.maxBytes) throw tooLarge(this.maxBytes);
    const upload: Upload = { id: randomBytes(16).toString('base64url'), scope, expires: this.#now() + this.ttlMs, chunks: [], offset: 0, length, complete: false, writer: undefined, bytes: undefined };
    this.#uploads.set(upload.id, upload);
    return upload;
  }

  /** The upload if it exists, has not expired and belongs to `scope` — else undefined (a 404). */
  get(id: string, scope: string): Upload | undefined {
    this.#sweep();
    const upload = this.#uploads.get(id);
    return upload && upload.scope === scope ? upload : undefined;
  }

  /** The complete upload's bytes for an op input reference, or undefined. */
  resolve(id: string, scope: string): Uint8Array | undefined {
    const upload = this.get(id, scope);
    if (!upload?.complete) return undefined;
    upload.bytes ??= join(upload.chunks, upload.offset);
    upload.chunks = [upload.bytes];
    return upload.bytes;
  }

  append(upload: Upload, chunk: Uint8Array): void {
    if (upload.length !== undefined && upload.offset + chunk.byteLength > upload.length) {
      this.delete(upload);
      throw inconsistentLength(`content beyond Upload-Length ${upload.length}`);
    }
    if (upload.offset + chunk.byteLength > this.maxBytes) {
      this.delete(upload);
      throw tooLarge(this.maxBytes);
    }
    if (this.#stored + chunk.byteLength > this.storeBytes) {
      throw new ApueError(503, 'Service Unavailable', 'upload storage is full', { retryable: true }, { 'retry-after': '60' });
    }
    upload.chunks.push(chunk);
    upload.offset += chunk.byteLength;
    this.#stored += chunk.byteLength;
  }

  delete(upload: Upload): void {
    if (this.#uploads.get(upload.id) !== upload) return;
    this.#uploads.delete(upload.id);
    this.#stored -= upload.offset;
    upload.writer?.abort();
  }

  limits(upload?: Upload): string {
    const maxAge = Math.max(0, Math.ceil(((upload?.expires ?? this.#now() + this.ttlMs) - this.#now()) / 1000));
    return `max-size=${this.maxBytes}, max-age=${maxAge}`;
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
export async function handleUpload(req: Exchange, store: UploadStore, scope: string, path: string): Promise<UploadResponse> {
  const id = path === UPLOADS_PATH ? undefined : path.slice(UPLOADS_PATH.length + 1);
  if (id === undefined) {
    if (req.method === 'OPTIONS') return { status: 204, headers: { 'upload-limit': store.limits(), allow: 'OPTIONS, POST' } };
    if (req.method !== 'POST') throw notAllowed('OPTIONS, POST');
    return create(req, store, scope);
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

async function create(req: Exchange, store: UploadStore, scope: string): Promise<UploadResponse> {
  // Without Upload-Complete this is a plain (non-resumable) upload of the whole content.
  const complete = parseBoolean(req.headers['upload-complete'], 'Upload-Complete') ?? true;
  const length = parseInteger(req.headers['upload-length'], 'Upload-Length');
  const upload = store.create(scope, length);
  const location = `${UPLOADS_PATH}/${upload.id}`;
  if (req.headers['upload-draft-interop-version'] === UPLOAD_INTEROP_VERSION) {
    req.interim?.(104, { location, 'upload-limit': store.limits(upload), 'upload-draft-interop-version': UPLOAD_INTEROP_VERSION });
  }
  await receive(req, store, upload);
  if (complete) return finish(store, upload, location);
  return { status: 201, headers: { location, ...state(store, upload) } };
}

async function append(req: Exchange, store: UploadStore, upload: Upload): Promise<UploadResponse> {
  if (baseOf(req.headers['content-type']) !== PARTIAL_UPLOAD) {
    throw new ApueError(415, 'Unsupported Media Type', `appends need Content-Type: ${PARTIAL_UPLOAD}`);
  }
  const offset = parseInteger(req.headers['upload-offset'], 'Upload-Offset');
  const complete = parseBoolean(req.headers['upload-complete'], 'Upload-Complete');
  if (offset === undefined || complete === undefined) throw new ApueError(400, 'Bad Request', 'appends need Upload-Offset and Upload-Complete');
  // A newer append wins over one still in flight (its connection may be dead but not yet noticed).
  if (upload.writer) {
    upload.writer.abort();
    await upload.writer.done;
  }
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
    upload.length = length;
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
  upload.complete = true;
  upload.length = upload.offset;
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

function baseOf(contentType: string | string[] | undefined): string {
  return String(contentType ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

function join(parts: Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
