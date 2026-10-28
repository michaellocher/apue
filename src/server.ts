// apü server: contract-driven HTTP mapping (S2) over node:http2 (h2 + HTTP/1.1 fallback),
// unary JSON or framed streaming in both directions (S1).
import { createHash } from 'node:crypto';
import http2 from 'node:http2';
import type { AddressInfo, Socket } from 'node:net';
import type { Writable } from 'node:stream';
import { canonicalJson, hasRequestStream, hasResponseStream, isCacheableRead, type Api, type OpDef } from './api.ts';
import {
  concatBytes,
  decodeFrames,
  decodeJson,
  encodeFrame,
  encodeJson,
  FrameType,
  type EndInfo,
  type Problem,
} from './frame.ts';
import { MemoryIdempotencyStore, type IdempotencyStore, type StoredResponse } from './idempotency.ts';
import { drained } from './node-streams.ts';
import { ApueError, baseMediaType, Header, isAsyncIterable, MediaType, ProblemType } from './protocol.ts';
import { ValidationError } from './schema.ts';

export interface CallContext {
  readonly op: string;
  /** Aborted when the client goes away or the deadline (`apue-timeout`) passes. */
  readonly signal: AbortSignal;
  readonly headers: http2.IncomingHttpHeaders;
  readonly httpVersion: string;
  readonly method: string;
}

type Awaitable<T> = T | Promise<T>;

export type HandlerFor<D> =
  D extends OpDef<infer I, infer O, infer S>
    ? (
        input: S extends 'client' | 'bidi' ? AsyncIterable<I> : I,
        ctx: CallContext,
      ) => S extends 'server' | 'bidi' ? Awaitable<AsyncIterable<O>> : Awaitable<O>
    : never;

export type Handlers<A extends Api> = { [K in keyof A]: HandlerFor<A[K]> };

export interface ApueServerOptions {
  key: string | Buffer;
  cert: string | Buffer;
  /** Idle time after which a HEARTBEAT frame is sent (intermediary timeouts are 15–125 s). */
  heartbeatMs?: number;
  /** How long a stream may wait for its first item before headers are committed anyway. */
  commitAfterMs?: number;
  /** Frames are coalesced into one socket write until this many bytes are pending. 0 = no coalescing. */
  coalesceBytes?: number;
  maxBodyBytes?: number;
  /** HTTP/2 per-stream receive window (SETTINGS_INITIAL_WINDOW_SIZE). */
  streamWindow?: number;
  /** HTTP/2 per-connection receive window. */
  connectionWindow?: number;
  /** Validate (and strip unknown fields from) handler output. Default true: no accidental data leaks. */
  validateOutput?: boolean;
  /** Store for Idempotency-Key replays; `false` disables the feature. */
  idempotency?: IdempotencyStore | false;
}

export interface ApueServer {
  readonly server: http2.Http2SecureServer;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export const MANIFEST_PATH = '/.well-known/apue';
export const PROTOCOL_VERSION = 'draft-00';

const STREAM_HEADERS = {
  'content-type': MediaType.STREAM_JSON,
  'cache-control': 'no-store',
  // RFC 10036: ask intermediaries not to buffer; nginx honours X-Accel-Buffering.
  incremental: '?1',
  'x-accel-buffering': 'no',
};

const IDEMPOTENCY_KEY = 'idempotency-key';
const REPLAYED = 'apue-replayed';

// ---------------------------------------------------------------------------------------------
// Rendering: the same frame sequence as binary frames or as SSE (debug / curl view, §6).

export interface Renderer {
  readonly contentType: string;
  render(type: number, payload: Uint8Array, lane: number): Uint8Array;
}

export const frameRenderer: Renderer = {
  contentType: MediaType.STREAM_JSON,
  render: (type, payload, lane) => encodeFrame(type, payload, lane),
};

const SSE_EVENTS: Record<number, string> = {
  [FrameType.MSG]: 'msg',
  [FrameType.END]: 'end',
  [FrameType.BLOB]: 'blob',
  [FrameType.CHECKPOINT]: 'checkpoint',
  [FrameType.CREDIT]: 'credit',
};
const textEncoder = new TextEncoder();

export const sseRenderer: Renderer = {
  contentType: MediaType.SSE,
  render(type, payload, lane) {
    if (type === FrameType.HEARTBEAT) return textEncoder.encode(': hb\n\n');
    const name = SSE_EVENTS[type] ?? `x-${type}`;
    const data = type === FrameType.BLOB ? Buffer.from(payload).toString('base64') : Buffer.from(payload).toString('utf8');
    return textEncoder.encode(`event: ${lane === 0 ? name : `${name}:${lane}`}\ndata: ${data}\n\n`);
  },
};

// ---------------------------------------------------------------------------------------------
// FrameWriter: coalesces frames into few large writes (one h2 DATA burst + syscall per flush),
// flushes at the end of the current event-loop turn so latency stays low, honours backpressure.

export interface FrameWriterOptions {
  renderer?: Renderer;
  coalesceBytes?: number;
}

export class FrameWriter {
  /** Number of socket writes issued — exposed for tests and benchmarks. */
  writes = 0;
  #sink: Writable;
  #renderer: Renderer;
  #coalesceBytes: number;
  #pending: Uint8Array[] = [];
  #pendingBytes = 0;
  #scheduled = false;
  #lastWrite = performance.now();
  #heartbeat: NodeJS.Timeout | undefined;

  constructor(sink: Writable, options: FrameWriterOptions = {}) {
    this.#sink = sink;
    this.#renderer = options.renderer ?? frameRenderer;
    this.#coalesceBytes = options.coalesceBytes ?? 16 * 1024;
  }

  async frame(type: number, payload: Uint8Array, lane = 0): Promise<void> {
    const bytes = this.#renderer.render(type, payload, lane);
    this.#pending.push(bytes);
    this.#pendingBytes += bytes.byteLength;
    if (this.#pendingBytes >= this.#coalesceBytes) {
      this.flush();
    } else if (!this.#scheduled) {
      this.#scheduled = true;
      setImmediate(() => this.flush());
    }
    await drained(this.#sink);
  }

  msg(value: unknown, lane = 0): Promise<void> {
    return this.frame(FrameType.MSG, encodeJson(value), lane);
  }

  end(info: EndInfo, lane = 0): Promise<void> {
    return this.frame(FrameType.END, encodeJson(info), lane);
  }

  flush(): void {
    this.#scheduled = false;
    if (this.#pending.length === 0 || isClosed(this.#sink)) return;
    const chunk = concatBytes(this.#pending, this.#pendingBytes);
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#sink.write(chunk);
    this.writes++;
    this.#lastWrite = performance.now();
  }

  startHeartbeat(intervalMs: number): void {
    this.#heartbeat = setInterval(
      () => {
        if (performance.now() - this.#lastWrite >= intervalMs) void this.frame(FrameType.HEARTBEAT, new Uint8Array(0));
      },
      Math.max(1, Math.floor(intervalMs / 3)),
    );
    this.#heartbeat.unref();
  }

  close(): void {
    clearInterval(this.#heartbeat);
    this.flush();
  }
}

// ---------------------------------------------------------------------------------------------

type AnyHandler = (input: unknown, ctx: CallContext) => unknown;

export function createApueServer<A extends Api>(api: A, handlers: Handlers<A>, options: ApueServerOptions): ApueServer {
  const {
    heartbeatMs = 15_000,
    commitAfterMs = 50,
    coalesceBytes = 16 * 1024,
    maxBodyBytes = 1024 * 1024,
    streamWindow = 4 * 1024 * 1024,
    connectionWindow = 32 * 1024 * 1024,
    validateOutput = true,
  } = options;
  const idempotency = options.idempotency === false ? undefined : (options.idempotency ?? new MemoryIdempotencyStore());
  const handlerMap = handlers as unknown as Record<string, AnyHandler>;
  for (const name of Object.keys(api)) {
    if (typeof handlerMap[name] !== 'function') throw new Error(`missing handler for ${name}`);
  }
  const manifest = encodeJson(buildManifest(api));

  const serverOptions: http2.SecureServerOptions & { connectionWindowSize?: number } = {
    key: options.key,
    cert: options.cert,
    allowHTTP1: true,
    settings: { initialWindowSize: streamWindow },
    connectionWindowSize: connectionWindow, // Node ≥ 26.11
  };
  const server = http2.createSecureServer(serverOptions);
  const sockets = new Set<Socket>();
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on('connection', (socket: Socket) => {
    // Nagle + delayed ACK can stall small frames by 40–200 ms (research/02 §6).
    socket.setNoDelay(true);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('request', (req, res) => void handle(req, res));

  async function handle(req: http2.Http2ServerRequest, res: http2.Http2ServerResponse): Promise<void> {
    // Own completion flag: on RST_STREAM the h2 compat layer marks `res` finished before 'close',
    // so `writableFinished` cannot tell a cancelled stream from a completed one.
    const clientGone = new AbortController();
    let completed = false;
    const complete = () => (completed = true);
    res.on('close', () => {
      if (!completed) clientGone.abort(new ApueError(499, 'Client Closed Request'));
    });
    let signal = clientGone.signal;
    const method = req.method;
    const head = method === 'HEAD';
    let idempotencyKey: string | undefined;
    try {
      const url = new URL(req.url, 'https://apue.invalid');
      if (url.pathname === MANIFEST_PATH) {
        if (method !== 'GET' && !head) throw methodNotAllowed(method, 'GET, HEAD');
        complete();
        return sendCacheable(req, res, manifest, { 'cache-control': 'no-cache' });
      }
      const opName = decodeURIComponent(url.pathname.slice(1));
      const def: OpDef | undefined = Object.hasOwn(api, opName) ? api[opName] : undefined;
      if (!def) throw new ApueError(404, 'Unknown Operation', opName, { type: ProblemType.UNKNOWN_OPERATION });
      const handler = handlerMap[opName]!;

      const read = isCacheableRead(def);
      const allow = read ? 'GET, HEAD, QUERY, POST' : 'POST';
      if (!allow.split(', ').includes(method)) throw methodNotAllowed(method, allow);
      if (def.deprecated) {
        for (const [name, value] of Object.entries(deprecationHeaders(def.deprecated))) res.setHeader(name, value);
      }
      if (read) res.setHeader('accept-query', `"${MediaType.JSON}"`);

      const timeoutMs = parseTimeout(req.headers[Header.TIMEOUT]);
      if (timeoutMs !== undefined) signal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);

      let input: unknown;
      if (method === 'GET' || head) {
        input = parseQueryInput(url);
      } else if (hasRequestStream(def)) {
        if (baseMediaType(req.headers['content-type']) !== MediaType.STREAM_JSON) {
          throw new ApueError(415, 'Unsupported Media Type', `${opName} expects ${MediaType.STREAM_JSON}`);
        }
        input = validatedStream(readInputStream(req), def);
      } else {
        input = await readJsonBody(req, maxBodyBytes, method === 'QUERY');
      }
      if (!hasRequestStream(def)) input = validateInput(def, input);

      // Idempotency-Key: only for unary non-safe ops (safe ops are idempotent by definition).
      const keyHeader = req.headers[IDEMPOTENCY_KEY];
      if (typeof keyHeader === 'string' && idempotency && def.effect !== 'safe' && def.stream === 'none') {
        const key = parseIdempotencyKey(keyHeader);
        const scope = `${opName}\n${hash(String(req.headers.authorization ?? ''))}\n${key}`;
        const claim = idempotency.begin(scope, hash(canonicalJson(input ?? null)));
        if (claim.state === 'replay') {
          complete();
          return replay(res, claim.response);
        }
        if (claim.state === 'in-progress') {
          throw new ApueError(409, 'Idempotency Key In Progress', 'a request with this Idempotency-Key is still being processed', {
            type: ProblemType.IDEMPOTENCY_IN_PROGRESS,
            retryable: true,
          });
        }
        if (claim.state === 'mismatch') {
          throw new ApueError(422, 'Idempotency Key Reused', 'Idempotency-Key was already used with a different request payload', {
            type: ProblemType.IDEMPOTENCY_MISMATCH,
          });
        }
        idempotencyKey = scope;
      }

      if (head && hasResponseStream(def)) {
        complete();
        res.writeHead(200, { ...STREAM_HEADERS, vary: 'accept' });
        return void res.end();
      }
      const ctx: CallContext = { op: opName, signal, headers: req.headers, httpVersion: req.httpVersion, method };
      const result = await abortable(Promise.resolve(handler(input, ctx)), signal);

      if (hasResponseStream(def)) {
        if (!isAsyncIterable(result)) throw new Error(`handler for streaming op ${opName} did not return an AsyncIterable`);
        const items = validateOutput ? mapAsync(result, (item) => def.output.parse(item)) : result;
        return await streamResponse(req, res, items, signal, clientGone.signal, complete);
      }
      const body = encodeJson((validateOutput ? def.output.parse(result) : result) ?? null);
      complete();
      if (read) return sendCacheable(req, res, body, { 'cache-control': cacheControl(def) });
      const headers = { 'content-type': MediaType.JSON, 'cache-control': 'no-store' };
      if (idempotencyKey) idempotency!.complete(idempotencyKey, { status: 200, headers, body });
      return sendBytes(res, 200, headers, body);
    } catch (error) {
      if (clientGone.signal.aborted) {
        if (idempotencyKey) idempotency!.release(idempotencyKey);
        return;
      }
      const problem = toProblem(error);
      complete();
      const headers: Record<string, string> = { 'content-type': MediaType.PROBLEM, 'cache-control': 'no-store' };
      if (error instanceof ApueError) Object.assign(headers, error.headers);
      const body = encodeJson(problem);
      if (idempotencyKey) {
        // Deterministic client errors are stored so a retry gets the same answer; server errors
        // release the key so a retry can execute again.
        if (problem.status < 500) idempotency!.complete(idempotencyKey, { status: problem.status, headers, body });
        else idempotency!.release(idempotencyKey);
      }
      if (res.headersSent) return void res.end();
      sendBytes(res, problem.status, headers, head ? undefined : body, body.byteLength);
    }
  }

  async function streamResponse(
    req: http2.Http2ServerRequest,
    res: http2.Http2ServerResponse,
    items: AsyncIterable<unknown>,
    signal: AbortSignal,
    gone: AbortSignal,
    complete: () => void,
  ): Promise<void> {
    const iterator = items[Symbol.asyncIterator]();
    const first = abortable(iterator.next(), signal);
    // Early phase: if the stream fails before its first item, answer with a real HTTP status
    // (visible to proxies and dashboards). Otherwise commit headers no later than commitAfterMs.
    const early = await settledWithin(first, commitAfterMs);
    if (early.status === 'rejected') {
      void iterator.return?.();
      throw early.reason;
    }

    const accept = req.headers.accept ?? '';
    const renderer = accept.includes(MediaType.SSE) && !accept.includes(MediaType.STREAM_JSON) ? sseRenderer : frameRenderer;
    res.writeHead(200, { ...STREAM_HEADERS, 'content-type': renderer.contentType, vary: 'accept' });
    const writer = new FrameWriter(res, { renderer, coalesceBytes });
    writer.startHeartbeat(heartbeatMs);
    try {
      let next = early.status === 'fulfilled' ? early.value : await first;
      while (!next.done) {
        await writer.msg(next.value);
        next = await abortable(iterator.next(), signal);
      }
      await writer.end({ status: 200 });
    } catch (error) {
      void iterator.return?.();
      if (gone.aborted) return;
      const problem = toProblem(error);
      await writer.end({ status: problem.status, problem });
    } finally {
      writer.close();
      if (!gone.aborted) {
        complete();
        res.end();
      }
    }
  }

  return {
    server,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve((server.address() as AddressInfo).port);
        });
      });
    },
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Graceful GOAWAY for h2 sessions, then drop remaining (HTTP/1.1 keep-alive) sockets.
      await Promise.all([...sessions].map((session) => new Promise<void>((resolve) => session.close(() => resolve()))));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Manifest (§11): machine-readable contract, served at /.well-known/apue.

export function buildManifest(api: Api): Record<string, unknown> {
  return {
    apue: PROTOCOL_VERSION,
    ops: Object.fromEntries(
      Object.entries(api).map(([name, def]) => [
        name,
        {
          effect: def.effect,
          stream: def.stream,
          ...(def.description ? { description: def.description } : {}),
          input: def.input.toJSONSchema(),
          output: def.output.toJSONSchema(),
          ...(def.cache ? { cache: def.cache } : {}),
          ...(def.deprecated
            ? {
                deprecated: {
                  since: def.deprecated.since.toISOString(),
                  ...(def.deprecated.sunset ? { sunset: def.deprecated.sunset.toISOString() } : {}),
                  ...(def.deprecated.link ? { link: def.deprecated.link } : {}),
                },
              }
            : {}),
        },
      ]),
    ),
  };
}

export function deprecationHeaders(deprecated: NonNullable<OpDef['deprecated']>): Record<string, string> {
  const headers: Record<string, string> = { deprecation: `@${Math.floor(deprecated.since.getTime() / 1000)}` };
  if (deprecated.sunset) headers.sunset = deprecated.sunset.toUTCString();
  if (deprecated.link) headers.link = `<${deprecated.link}>; rel="deprecation"`;
  return headers;
}

// ---------------------------------------------------------------------------------------------

function methodNotAllowed(method: string, allow: string): ApueError {
  return new ApueError(405, 'Method Not Allowed', `${method} is not allowed here`, {}, { allow });
}

function parseQueryInput(url: URL): unknown {
  const values = url.searchParams.getAll('i');
  if (values.length > 1) throw new ApueError(400, 'Bad Request', 'query parameter i given more than once');
  if (values.length === 0) return undefined;
  try {
    return JSON.parse(values[0]!);
  } catch {
    throw new ApueError(400, 'Bad Request', 'query parameter i is not valid JSON');
  }
}

async function readJsonBody(req: http2.Http2ServerRequest, maxBodyBytes: number, query: boolean): Promise<unknown> {
  const type = baseMediaType(req.headers['content-type']);
  // RFC 10008 §2: servers MUST fail a QUERY whose Content-Type is missing.
  if (query && !type) throw new ApueError(400, 'Bad Request', 'QUERY requires a Content-Type');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > maxBodyBytes) throw new ApueError(413, 'Content Too Large', `limit is ${maxBodyBytes} bytes`);
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  if (type !== MediaType.JSON) throw new ApueError(415, 'Unsupported Media Type', `expected ${MediaType.JSON}, got ${type || 'none'}`);
  try {
    return decodeJson(concatBytes(chunks, size));
  } catch {
    throw new ApueError(400, 'Bad Request', 'body is not valid JSON');
  }
}

async function* readInputStream(req: http2.Http2ServerRequest): AsyncGenerator<unknown> {
  for await (const frame of decodeFrames(req as AsyncIterable<Uint8Array>)) {
    if (frame.type === FrameType.MSG) {
      yield decodeJson(frame.payload);
    } else if (frame.type === FrameType.END) {
      const info = decodeJson(frame.payload) as EndInfo;
      if (info.status >= 400) throw ApueError.fromProblem(info.problem, info.status);
      return;
    }
  }
  throw new ApueError(400, 'Truncated Stream', 'request body ended without END frame', { type: ProblemType.TRUNCATED_STREAM });
}

async function* validatedStream(source: AsyncIterable<unknown>, def: OpDef): AsyncGenerator<unknown> {
  let index = 0;
  for await (const item of source) {
    try {
      yield def.input.parse(item);
    } catch (error) {
      if (error instanceof ValidationError) throw validationProblem(error, `input message ${index}`);
      throw error;
    }
    index++;
  }
}

async function* mapAsync<T, R>(source: AsyncIterable<T>, fn: (item: T) => R): AsyncGenerator<R> {
  for await (const item of source) yield fn(item);
}

function validateInput(def: OpDef, input: unknown): unknown {
  try {
    return def.input.parse(input);
  } catch (error) {
    if (error instanceof ValidationError) throw validationProblem(error, 'input');
    throw error;
  }
}

function validationProblem(error: ValidationError, what: string): ApueError {
  return new ApueError(400, 'Validation Failed', `${what} does not match the schema`, { type: ProblemType.VALIDATION, fields: error.issues });
}

function parseIdempotencyKey(value: string): string {
  // Structured Field String (RFC 9651 §3.3.3): "…" of printable ASCII. Bare tokens are tolerated.
  const match = /^"((?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\])*)"$/.exec(value.trim());
  const key = match ? match[1]!.replace(/\\(["\\])/g, '$1') : value.trim();
  if (key.length === 0 || key.length > 255 || !/^[\x20-\x7e]+$/.test(key)) {
    throw new ApueError(400, 'Bad Request', 'invalid Idempotency-Key');
  }
  return key;
}

function cacheControl(def: OpDef): string {
  const policy = def.cache;
  if (!policy || policy.maxAge === undefined) return policy?.private ? 'private, no-cache' : 'no-cache';
  const parts = [policy.private ? 'private' : 'public', `max-age=${policy.maxAge}`];
  if (policy.staleWhileRevalidate !== undefined) parts.push(`stale-while-revalidate=${policy.staleWhileRevalidate}`);
  return parts.join(', ');
}

function hash(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('base64url');
}

/** Strong ETag over the representation bytes; If-None-Match → 304 (RFC 9110 §13.1.2). */
function sendCacheable(
  req: http2.Http2ServerRequest,
  res: http2.Http2ServerResponse,
  body: Uint8Array,
  headers: Record<string, string>,
): void {
  const etag = `"${hash(body).slice(0, 22)}"`;
  if (ifNoneMatch(req.headers['if-none-match'], etag)) return sendBytes(res, 304, { etag, ...headers });
  sendBytes(res, 200, { 'content-type': MediaType.JSON, etag, ...headers }, req.method === 'HEAD' ? undefined : body, body.byteLength);
}

function ifNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  // If-None-Match uses weak comparison (RFC 9110 §13.1.2): W/ prefixes are ignored.
  return header.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag);
}

function replay(res: http2.Http2ServerResponse, stored: StoredResponse): void {
  sendBytes(res, stored.status, { ...stored.headers, [REPLAYED]: '?1' }, stored.body);
}

function sendBytes(
  res: http2.Http2ServerResponse,
  status: number,
  headers: Record<string, string>,
  body?: Uint8Array,
  contentLength = body?.byteLength,
): void {
  res.writeHead(status, contentLength === undefined || status === 304 ? headers : { ...headers, 'content-length': String(contentLength) });
  if (body) res.end(body);
  else res.end();
}

function toProblem(error: unknown): Problem {
  if (error instanceof ApueError) return error.problem;
  if (error instanceof ValidationError) {
    // Only output validation reaches here (input errors are converted earlier) → server bug.
    console.error('apü: handler output does not match schema:', error.message);
    return { title: 'Internal Server Error', status: 500 };
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return { type: ProblemType.DEADLINE, title: 'Deadline Exceeded', status: 504, retryable: true };
  }
  console.error('apü handler error:', error);
  return { title: 'Internal Server Error', status: 500 };
}

function parseTimeout(value: string | string[] | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms <= 0) throw new ApueError(400, 'Bad Request', `invalid ${Header.TIMEOUT}`);
  return ms;
}

function isClosed(sink: Writable): boolean {
  return sink.destroyed === true || sink.writableEnded;
}

/** Rejects with the signal's reason as soon as it aborts; the underlying promise keeps running. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

type Early<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown } | { status: 'pending' };

function settledWithin<T>(promise: Promise<T>, ms: number): Promise<Early<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: 'pending' }), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ status: 'fulfilled', value });
      },
      (reason) => {
        clearTimeout(timer);
        resolve({ status: 'rejected', reason });
      },
    );
  });
}
