// Resumable uploads (draft-ietf-httpbis-resumable-upload-14, interop version 10; research/06): binary
// values are uploaded to `/$uploads` — resumably, over plain HTTP requests — and op inputs reference
// them as { "$upload": id } where the schema says t.bytes() (SPEC-DRAFT §6). Node-only.
import { createHash, randomBytes, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, truncate, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileValue } from './schema.ts';
import type { Exchange } from './exchange.ts';
import { concatBytes } from './frame.ts';
import { ApueError, baseMediaType, MediaType, UPLOAD_INTEROP_VERSION, UPLOADS_PATH } from './protocol.ts';

export { UPLOAD_INTEROP_VERSION, UPLOADS_PATH };
export const PARTIAL_UPLOAD = 'application/partial-upload';
const PROBLEMS = 'https://iana.org/assignments/http-problem-types';
/** File-backed uploads are written in blocks of this size. */
const WRITE_BLOCK = 1024 * 1024;
/** Upload ids: 128 random bits, base64url. */
const UPLOAD_ID = /^[A-Za-z0-9_-]{22}$/;

export interface UploadOptions {
  /** Largest upload (Upload-Limit max-size). Default 64 MiB. */
  maxBytes?: number;
  /** All uploads together, complete or not; beyond it new data is refused with 503. Default 256 MiB. */
  storeBytes?: number;
  /** Lifetime of an upload resource from its creation (Upload-Limit max-age). Default 1 h. */
  ttlMs?: number;
  /**
   * Bytes one client may hold, received or announced (Upload-Length), so one client can't lock
   * out the rest. Default storeBytes / 4. One client is one principal when the server has a
   * `principal` hook, else one address.
   */
  scopeBytes?: number;
  /** Upload resources one client may hold, complete or not. Default 100. */
  scopeUploads?: number;
  /**
   * Keep upload content in files under this directory instead of memory (spike S20): uploads in
   * progress cost no RAM, and t.file() inputs reach handlers as streams from these files. A
   * per-process subdirectory is created and removed on close; uploads don't survive a restart
   * unless `persistent`.
   */
  directory?: string;
  /**
   * With `directory`: uploads survive a restart. They live in `<directory>/apue-uploads` (one
   * process per directory, guarded by a lock file a dead process's lock doesn't block), each with
   * a metadata file. At the end of every request the received content is synced to disk and its
   * length recorded; on startup a file is cut back to that length (bytes never acknowledged are
   * dropped, so content is never corrupt — the client's offset retrieval sends them again),
   * expired and orphaned files are removed, and the quotas are rebuilt. Call `init()` (the
   * server's `listen()` does) before serving.
   */
  persistent?: boolean;
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
  /**
   * With `directory`: the file holding the content (instead of `chunks`), bytes written to it, data
   * not yet written, and the handle of the request writing it — open only while one is: an
   * upload waiting for its next request holds no descriptor (100 empty uploads per client would
   * otherwise exhaust the process's descriptors).
   */
  file: { path: string; handle: FileHandle | undefined; written: number; pending: Uint8Array[]; pendingBytes: number } | undefined;
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
  #directory: string | undefined;
  #files: Promise<string> | undefined; // the per-process subdirectory, created on first use
  #persistent: boolean;
  #ready: Promise<void> | undefined;
  #lock: string | undefined;

  constructor({ maxBytes = 64 * 1024 * 1024, storeBytes = 256 * 1024 * 1024, ttlMs = 60 * 60 * 1000, scopeBytes, scopeUploads = 100, directory, persistent = false, now = Date.now }: UploadOptions = {}) {
    // A typo like `2 << 30` (negative) or a fraction would silently refuse or misaccount everything.
    for (const [name, value] of Object.entries({ maxBytes, storeBytes, ttlMs, scopeBytes, scopeUploads })) {
      if (value !== undefined && !(Number.isSafeInteger(value) && value > 0)) throw new RangeError(`uploads.${name} must be a positive integer, got ${value}`);
    }
    if (persistent && directory === undefined) throw new Error('uploads.persistent needs uploads.directory');
    this.#directory = directory;
    this.#persistent = persistent;
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

  /** Loads the persisted uploads (persistent mode; a no-op otherwise). Call once before serving. */
  init(): Promise<void> {
    return (this.#ready ??= this.#persistent ? this.#load() : Promise.resolve());
  }

  async create(scope: string, quota: string, length: number | undefined): Promise<Upload> {
    if (this.#persistent) await this.init();
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
      file: undefined,
    };
    if (this.#directory) {
      this.#files ??= mkdtemp(join(this.#directory, 'apue-uploads-'));
      const path = join(await this.#files, upload.id);
      await (await open(path, 'wx')).close();
      upload.file = { path, handle: undefined, written: 0, pending: [], pendingBytes: 0 };
    }
    this.#uploads.set(upload.id, upload);
    usage.uploads++;
    usage.bytes += upload.reserved;
    await this.#writeMeta(upload);
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
  async resolve(id: string, scope: string): Promise<{ bytes: Uint8Array; digest: string } | undefined> {
    const upload = this.get(id, scope);
    if (!upload?.complete) return undefined;
    if (upload.file) return { bytes: new Uint8Array(await readFile(upload.file.path)), digest: upload.digest! }; // a fresh buffer each time
    upload.bytes ??= concatBytes(upload.chunks, upload.offset);
    upload.chunks = [upload.bytes];
    return { bytes: upload.bytes.slice(), digest: upload.digest! };
  }

  /**
   * The complete upload as a t.file() value — streamed, never held in memory (with `directory`).
   * Readable until `release()`, even if the upload is deleted or expires meanwhile: the file is
   * opened here and an open file outlives its unlink (POSIX). Undefined if not usable.
   */
  async openFile(id: string, scope: string): Promise<{ value: FileValue; release: () => Promise<void> } | undefined> {
    const upload = this.get(id, scope);
    if (!upload?.complete) return undefined;
    const { file, offset: size, digest } = upload;
    if (!file) {
      const chunks = upload.chunks;
      // Copies, like resolve(): a handler writing into a chunk must not change the upload.
      const stream = async function* () {
        for (const chunk of chunks) yield chunk.slice();
      };
      return { value: { size, sha256: digest!, stream }, release: async () => {} };
    }
    let handle: FileHandle;
    try {
      handle = await open(file.path, 'r');
    } catch {
      return undefined; // deleted between the lookup and the open
    }
    return {
      // Positional reads (start: 0): several streams of one value don't disturb each other.
      value: { size, sha256: digest!, stream: () => handle.createReadStream({ start: 0, autoClose: false }) as AsyncIterable<Uint8Array> },
      release: () => handle.close().catch(() => {}),
    };
  }

  /** Removes the per-process directory (and every upload file in it) — or, persistent, releases it. */
  async close(): Promise<void> {
    const directory = await this.#files;
    for (const upload of this.#uploads.values()) await upload.file?.handle?.close().catch(() => {});
    if (this.#persistent) {
      if (this.#lock) await unlink(this.#lock).catch(() => {});
      this.#lock = undefined;
    } else if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async append(upload: Upload, chunk: Uint8Array): Promise<void> {
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
    if (upload.file) {
      // Coalesced: one async write per ~16 KiB HTTP/2 chunk ran at 46 MiB/s (the libuv thread pool).
      upload.file.pending.push(chunk);
      upload.file.pendingBytes += chunk.byteLength;
      if (upload.file.pendingBytes >= WRITE_BLOCK) await this.flush(upload);
    } else {
      upload.chunks.push(chunk);
    }
    upload.hash.update(chunk);
    upload.offset += chunk.byteLength;
    upload.reserved -= covered;
    this.#stored += chunk.byteLength;
    usage.bytes += extra;
  }

  /** Writes what is buffered for a file-backed upload (end of each request; before it is read). */
  async flush(upload: Upload): Promise<void> {
    const file = upload.file;
    if (!file || file.pendingBytes === 0) return;
    const block = concatBytes(file.pending, file.pendingBytes);
    file.pending = [];
    file.pendingBytes = 0;
    try {
      file.handle ??= await open(file.path, 'r+');
      await file.handle.write(block, 0, block.byteLength, file.written);
      file.written += block.byteLength;
    } catch (error) {
      // Deleted meanwhile (its handle closed, its file unlinked): that is not a storage failure.
      if (this.#uploads.get(upload.id) !== upload) throw notFound();
      // The offset already counts these bytes: an upload missing them on disk must not be resumed
      // (it would complete with corrupt content) — it is gone, the client starts over.
      this.delete(upload);
      throw new ApueError(507, 'Insufficient Storage', `writing the upload failed: ${(error as Error).message}`);
    }
    // Deleted while the write was pending: its accounting is already gone — don't add to it.
    if (this.#uploads.get(upload.id) !== upload) throw notFound();
  }

  /**
   * Closes the write handle at the end of a request (the next one opens its own). Persistent:
   * syncs the content first and records its length — what a restart keeps.
   */
  async closeWriter(upload: Upload): Promise<void> {
    const handle = upload.file?.handle;
    if (handle) {
      upload.file!.handle = undefined;
      if (this.#persistent) await handle.sync().catch(() => {});
      await handle.close().catch(() => {});
    }
    await this.#writeMeta(upload);
  }

  /** Marks the upload complete: its content and digest are final. */
  async seal(upload: Upload): Promise<void> {
    upload.complete = true;
    upload.length = upload.offset;
    upload.digest ??= upload.hash.digest('hex');
    await this.#writeMeta(upload);
  }

  /** Persistent: the upload's metadata, written atomically (temporary file, sync, rename). */
  async #writeMeta(upload: Upload): Promise<void> {
    if (!this.#persistent || !upload.file || this.#uploads.get(upload.id) !== upload) return;
    const { id, scope, quota, expires, length, complete, digest } = upload;
    const meta = { v: 1, id, scope, quota, expires, offset: upload.file.written, length: length ?? null, complete, digest: digest ?? null };
    const path = `${upload.file.path}.json`;
    const temporary = `${path}.tmp`;
    const handle = await open(temporary, 'w');
    try {
      await handle.writeFile(JSON.stringify(meta));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    // Deleted meanwhile: don't leave its metadata behind.
    if (this.#uploads.get(upload.id) !== upload) await unlink(path).catch(() => {});
  }

  /** Persistent startup: lock the directory, restore valid uploads, remove everything else. */
  async #load(): Promise<void> {
    const directory = join(this.#directory!, 'apue-uploads');
    await mkdir(directory, { recursive: true });
    await this.#acquireLock(directory);
    this.#files = Promise.resolve(directory);
    const names = await readdir(directory);
    const restored: Upload[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const upload = await this.#restore(directory, name.slice(0, -'.json'.length)).catch(() => undefined);
      if (upload) restored.push(upload);
    }
    const kept = new Set(restored.flatMap((upload) => [upload.id, `${upload.id}.json`]));
    // Expired, invalid or orphaned (data without metadata, metadata without data, temporary files).
    for (const name of names) if (name !== '.lock' && !kept.has(name)) await unlink(join(directory, name)).catch(() => {});
    restored.sort((a, b) => a.expires - b.expires); // insertion order = expiry order (#sweep)
    for (const upload of restored) {
      this.#uploads.set(upload.id, upload);
      this.#stored += upload.offset;
      const usage = this.#usageOf(upload.quota);
      usage.uploads++;
      usage.bytes += upload.offset + upload.reserved;
    }
  }

  async #restore(directory: string, id: string): Promise<Upload | undefined> {
    if (!UPLOAD_ID.test(id)) return undefined;
    const meta = JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')) as Record<string, unknown>;
    const { scope, quota, expires, offset, length, complete, digest } = meta;
    const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
    if (meta.v !== 1 || meta.id !== id || typeof scope !== 'string' || typeof quota !== 'string' || !count(expires) || !count(offset)) return undefined;
    if (!(length === null || (count(length) && length >= offset)) || typeof complete !== 'boolean') return undefined;
    if (complete && (length !== offset || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest))) return undefined;
    if (expires <= this.#now()) return undefined;
    const path = join(directory, id);
    const size = (await stat(path)).size;
    if (size < offset) return undefined; // recorded content missing: unusable
    if (size > offset) await truncate(path, offset); // never acknowledged: dropped
    const hash = createHash('sha256');
    // An incomplete upload's digest continues where it stopped: recomputed from the content.
    if (!complete) for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
    return {
      id,
      scope,
      quota,
      expires,
      chunks: [],
      offset,
      length: length ?? undefined,
      complete,
      writer: undefined,
      bytes: undefined,
      reserved: length === null ? 0 : length - offset,
      file: { path, handle: undefined, written: offset, pending: [], pendingBytes: 0 },
      hash,
      digest: complete ? (digest as string) : undefined,
    };
  }

  /** One process per directory: a lock file with the owner's pid; a dead owner's lock is taken over. */
  async #acquireLock(directory: string): Promise<void> {
    const lock = join(directory, '.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(lock, 'wx');
        await handle.writeFile(String(process.pid));
        await handle.close();
        this.#lock = lock;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owner = Number(await readFile(lock, 'utf8').catch(() => ''));
        if (Number.isSafeInteger(owner) && owner > 0 && isAlive(owner)) throw new Error(`uploads.directory ${this.#directory} is in use by process ${owner}`);
        await unlink(lock).catch(() => {}); // stale: its process is gone
      }
    }
    throw new Error(`uploads.directory ${this.#directory}: could not take the lock`);
  }

  delete(upload: Upload): void {
    if (this.#uploads.get(upload.id) !== upload) return;
    this.#uploads.delete(upload.id);
    this.#stored -= upload.offset;
    const usage = this.#usageOf(upload.quota);
    usage.bytes -= upload.offset + upload.reserved;
    if (--usage.uploads === 0) this.#usage.delete(upload.quota);
    upload.writer?.abort();
    if (upload.file) {
      const { handle, path } = upload.file;
      upload.file.handle = undefined;
      void (handle ? handle.close().catch(() => {}) : Promise.resolve()).then(() => unlink(path)).catch(() => {});
      if (this.#persistent) void unlink(`${path}.json`).catch(() => {});
    }
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
  const upload = await store.create(scope, quota, length);
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
      if (next === 'aborted') throw new ApueError(409, 'Conflict', 'superseded by a newer request to this upload (or cancelled)');
      if (next.done) break;
      await store.append(upload, new Uint8Array(next.value));
    }
  } catch (error) {
    if (error instanceof ApueError) throw error;
    // The client went away mid-content: what arrived stays, the client resumes from Upload-Offset.
    throw new ApueError(499, 'Client Closed Request', 'upload interrupted');
  } finally {
    // Release the body however the loop ended (refused, superseded, done): the iterator's 'readable'
    // listener makes resume() a no-op, so the unread rest would never be drained and the stream —
    // and with it the connection and server.close() — would never end. Not awaited: a superseded
    // request's pending next() may never resolve.
    void chunks.return?.()?.catch(() => {});
    // What arrived is on disk before the next request (resume, superseding append) or a read.
    await store.flush(upload).catch(() => {}); // a failed write deletes the upload (see flush)
    await store.closeWriter(upload);
    if (upload.writer === writer) upload.writer = undefined;
    settle();
  }
}

async function finish(store: UploadStore, upload: Upload, location: string): Promise<UploadResponse> {
  if (upload.length !== undefined && upload.offset !== upload.length) {
    store.delete(upload);
    throw inconsistentLength(`completed at ${upload.offset} bytes, Upload-Length was ${upload.length}`);
  }
  await store.seal(upload);
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

/** Whether a process exists (EPERM: it does, owned by someone else). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
