// apü server: contract-driven HTTP mapping (S2) over node:http2 (h2 + HTTP/1.1 fallback),
// unary JSON or framed streaming in both directions (S1).
import { hash as cryptoHash } from 'node:crypto';
import http2 from 'node:http2';
import type { AddressInfo, Socket } from 'node:net';
import type { Transform, Writable } from 'node:stream';
import { canonicalJson, hasRequestStream, hasResponseStream, isCacheableRead, type Api, type OpDef } from './api.ts';
import {
  concatBytes,
  decodeFrames,
  decodeJson,
  encodeFrame,
  encodeJson,
  FrameType,
  jsonFrame,
  type EndInfo,
  type Problem,
} from './frame.ts';
import { MemoryIdempotencyStore, type IdempotencyStore, type StoredResponse } from './idempotency.ts';
import { compressAsync, compressSync, createCompressor, DEFAULT_CODINGS, flushCompressor, negotiate, type Coding } from './compression.ts';
import { onExchange, type Exchange } from './exchange.ts';
import { drained } from './node-streams.ts';
import { ApueError, baseMediaType, Header, isAsyncIterable, MediaType, ProblemType } from './protocol.ts';
import { collectRefs, RefError, resolveRefs } from './refs.ts';
import { ValidationError, type Schema } from './schema.ts';

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
  /** Response bytes buffered per stream before a producer waits (FrameWriter backpressure). */
  maxBufferedBytes?: number;
  /** HTTP/2 per-stream receive window (SETTINGS_INITIAL_WINDOW_SIZE). */
  streamWindow?: number;
  /** HTTP/2 per-connection receive window. */
  connectionWindow?: number;
  /** Validate (and strip unknown fields from) handler output. Default true: no accidental data leaks. */
  validateOutput?: boolean;
  /** Store for Idempotency-Key replays; `false` disables the feature. */
  idempotency?: IdempotencyStore | false;
  /** Maximum number of calls in one pipelined batch. */
  maxBatchCalls?: number;
  /** Response compression (Accept-Encoding); `false` disables it. */
  compression?: false | { codings?: readonly Coding[]; minBytes?: number };
  /** Cross-origin access for browsers. Same-origin deployment needs none (and saves preflights). */
  cors?: CorsOptions;
}

export interface CorsOptions {
  /** Allowed origins (exact match), or '*' for any. Credentials are only allowed with a list. */
  origins: readonly string[] | '*';
  /** Preflight cache lifetime; browsers cap it (Chromium 7200 s, Firefox 86400 s, WebKit 600 s). */
  maxAge?: number;
  credentials?: boolean;
}

export interface ApueServer {
  readonly server: http2.Http2SecureServer;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export const MANIFEST_PATH = '/.well-known/apue';
export const BATCH_PATH = '/';
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
  /** Renders a JSON-payload frame without an intermediate payload buffer. */
  renderJson(type: number, value: unknown, lane: number): Uint8Array;
}

export const frameRenderer: Renderer = {
  contentType: MediaType.STREAM_JSON,
  render: (type, payload, lane) => encodeFrame(type, payload, lane),
  renderJson: (type, value, lane) => jsonFrame(type, value, lane),
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
  renderJson(type, value, lane) {
    const name = SSE_EVENTS[type] ?? `x-${type}`;
    return Buffer.from(`event: ${lane === 0 ? name : `${name}:${lane}`}\ndata: ${JSON.stringify(value) ?? 'null'}\n\n`);
  },
};

// ---------------------------------------------------------------------------------------------
// FrameWriter: coalesces frames into few large writes (one h2 DATA burst + syscall per flush),
// flushes at the end of the current event-loop turn so latency stays low, honours backpressure.

export interface FrameWriterOptions {
  renderer?: Renderer;
  coalesceBytes?: number;
  /**
   * Bytes that may sit in the sink's buffer before the producer waits for 'drain'. Waiting at the
   * stream's 16 KiB default high-water mark costs an event-loop round trip per coalesced flush.
   */
  maxBufferedBytes?: number;
  /** Called after each flushed write, e.g. to flush a compressor so the burst leaves right away. */
  afterFlush?: () => void;
}

export class FrameWriter {
  /** Number of socket writes issued — exposed for tests and benchmarks. */
  writes = 0;
  #sink: Writable;
  #renderer: Renderer;
  #coalesceBytes: number;
  #maxBufferedBytes: number;
  #afterFlush: (() => void) | undefined;
  #pending: Uint8Array[] = [];
  #pendingBytes = 0;
  #scheduled = false;
  #lastWrite = performance.now();
  #heartbeat: NodeJS.Timeout | undefined;

  constructor(sink: Writable, options: FrameWriterOptions = {}) {
    this.#sink = sink;
    this.#renderer = options.renderer ?? frameRenderer;
    this.#coalesceBytes = options.coalesceBytes ?? 16 * 1024;
    this.#maxBufferedBytes = options.maxBufferedBytes ?? 256 * 1024;
    this.#afterFlush = options.afterFlush;
  }

  // The write methods return a promise only while the sink needs draining, so producers can skip
  // an `await` (one microtask) per message: `const p = writer.msg(v); if (p) await p;`.
  frame(type: number, payload: Uint8Array, lane = 0): Promise<void> | undefined {
    return this.#push(this.#renderer.render(type, payload, lane));
  }

  msg(value: unknown, lane = 0): Promise<void> | undefined {
    return this.#push(this.#renderer.renderJson(FrameType.MSG, value, lane));
  }

  end(info: EndInfo, lane = 0): Promise<void> | undefined {
    return this.#push(this.#renderer.renderJson(FrameType.END, info, lane));
  }

  #push(bytes: Uint8Array): Promise<void> | undefined {
    this.#pending.push(bytes);
    this.#pendingBytes += bytes.byteLength;
    if (this.#pendingBytes >= this.#coalesceBytes) {
      this.flush();
    } else if (!this.#scheduled) {
      this.#scheduled = true;
      setImmediate(() => this.flush());
    }
    // Only wait when 'drain' is guaranteed to come (a write returned false): waiting on the buffer
    // size alone deadlocks when the sink's high-water mark is above maxBufferedBytes.
    const mustWait = this.#sink.writableNeedDrain && this.#sink.writableLength > this.#maxBufferedBytes;
    return mustWait ? drained(this.#sink) : undefined;
  }

  flush(): void {
    this.#scheduled = false;
    if (this.#pending.length === 0 || isClosed(this.#sink)) return;
    const chunk = this.#pending.length === 1 ? this.#pending[0]! : Buffer.concat(this.#pending, this.#pendingBytes);
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#sink.write(chunk);
    this.#afterFlush?.();
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
    maxBatchCalls = 64,
    maxBufferedBytes = 256 * 1024,
  } = options;
  const codings = options.compression === false ? [] : (options.compression?.codings ?? DEFAULT_CODINGS);
  const minCompressBytes = options.compression === false ? Infinity : (options.compression?.minBytes ?? 1024);
  const cors = options.cors;
  if (cors?.credentials && cors.origins === '*') throw new Error('cors: credentials require an explicit origin list');
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
  onExchange(server, (exchange) => void handle(exchange, exchange));

  // `req` and `res` are the same Exchange; the two names keep request- and response-side code readable.
  async function handle(req: Exchange, res: Exchange): Promise<void> {
    // Own completion flag: 'close' fires for completed and for reset streams alike.
    const clientGone = new AbortController();
    let completed = false;
    const complete = () => (completed = true);
    res.onClose(() => {
      if (!completed) clientGone.abort(new ApueError(499, 'Client Closed Request'));
    });
    let signal = clientGone.signal;
    const method = req.method;
    const head = method === 'HEAD';
    try {
      if (cors && applyCors(req, res, cors)) {
        complete();
        return; // preflight answered
      }
      const queryAt = req.url.indexOf('?');
      const pathname = queryAt === -1 ? req.url : req.url.slice(0, queryAt);
      const url = { pathname, search: queryAt === -1 ? '' : req.url.slice(queryAt) };
      if (url.pathname === MANIFEST_PATH) {
        if (method !== 'GET' && !head) throw methodNotAllowed(method, 'GET, HEAD');
        complete();
        return await sendBody(req, res, 200, { 'content-type': MediaType.JSON, 'cache-control': 'no-cache' }, manifest, true);
      }
      if (url.pathname === BATCH_PATH) return await handleBatch(req, res, timeoutSignal(signal, req), clientGone.signal, complete);
      const opName = decodeURIComponent(url.pathname.slice(1));
      const def: OpDef | undefined = Object.hasOwn(api, opName) ? api[opName] : undefined;
      if (!def) throw new ApueError(404, 'Unknown Operation', opName, { type: ProblemType.UNKNOWN_OPERATION });
      const read = isCacheableRead(def);
      const allow = read ? 'GET, HEAD, QUERY, POST' : 'POST';
      if (!allow.split(', ').includes(method)) throw methodNotAllowed(method, allow);
      if (def.deprecated) {
        for (const [name, value] of Object.entries(deprecationHeaders(def.deprecated))) res.setHeader(name, value);
      }
      if (read) res.setHeader('accept-query', `"${MediaType.JSON}"`);

      signal = timeoutSignal(signal, req);

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

      const ctx: CallContext = { op: opName, signal, headers: req.headers, httpVersion: req.httpVersion, method };
      if (!hasResponseStream(def)) {
        // Keys apply to plain unary calls only: a request stream cannot be fingerprinted or replayed.
        const keyHeader = req.headers[IDEMPOTENCY_KEY];
        const keyed = typeof keyHeader === 'string' && def.effect !== 'safe' && def.stream === 'none';
        const key = keyed ? parseIdempotencyKey(keyHeader) : undefined;
        const outcome = await runUnary(opName, def, input, ctx, key);
        if (outcome.aborted) return;
        complete();
        if (outcome.status === 200 && read) {
          return await sendBody(req, res, 200, { 'content-type': MediaType.JSON, 'cache-control': cacheControl(def) }, outcome.body, true);
        }
        const headers = outcome.replayed ? { ...outcome.headers, [REPLAYED]: '?1' } : outcome.headers;
        return await sendBody(req, res, outcome.status, headers, outcome.body, false);
      }

      if (head) {
        complete();
        return res.send(200, { ...STREAM_HEADERS, vary: 'accept' });
      }
      const result = await abortable(Promise.resolve(handlerMap[opName]!(input, ctx)), signal);
      if (!isAsyncIterable(result)) throw new Error(`handler for streaming op ${opName} did not return an AsyncIterable`);
      return await streamResponse(req, res, result, validateOutput ? def.output : undefined, signal, clientGone.signal, complete);
    } catch (error) {
      if (clientGone.signal.aborted) return;
      const problem = toProblem(error);
      complete();
      if (res.headersSent) return void res.end();
      const outcome = problemOutcome(problem, error);
      await sendBody(req, res, outcome.status, outcome.headers, outcome.body, false);
    }
  }

  interface Outcome extends StoredResponse {
    /** Decoded output (status 200) or problem object. */
    payload: unknown;
    replayed?: boolean;
    /** The client went away; nothing must be sent. */
    aborted?: boolean;
  }

  /**
   * Executes a unary op including Idempotency-Key handling. Never throws: failures become
   * problem outcomes, so HTTP calls and batch lanes behave identically.
   */
  async function runUnary(opName: string, def: OpDef, input: unknown, ctx: CallContext, key: string | undefined): Promise<Outcome> {
    let scope: string | undefined;
    if (key !== undefined && idempotency && def.effect !== 'safe') {
      scope = `${opName}\n${hash(String(ctx.headers.authorization ?? ''))}\n${key}`;
      const claim = idempotency.begin(scope, hash(canonicalJson(input ?? null)));
      if (claim.state === 'replay') {
        return { ...claim.response, payload: decodeJson(claim.response.body), replayed: true };
      }
      if (claim.state === 'in-progress') {
        return problemOutcome(
          new ApueError(409, 'Idempotency Key In Progress', 'a request with this Idempotency-Key is still being processed', {
            type: ProblemType.IDEMPOTENCY_IN_PROGRESS,
            retryable: true,
          }).problem,
        );
      }
      if (claim.state === 'mismatch') {
        return problemOutcome(
          new ApueError(422, 'Idempotency Key Reused', 'Idempotency-Key was already used with a different request payload', {
            type: ProblemType.IDEMPOTENCY_MISMATCH,
          }).problem,
        );
      }
    }
    try {
      const handler = handlerMap[opName]!;
      const result = await abortable(Promise.resolve(handler(input, ctx)), ctx.signal);
      const value = (validateOutput ? def.output.parse(result) : result) ?? null;
      const outcome: Outcome = {
        status: 200,
        headers: { 'content-type': MediaType.JSON, 'cache-control': 'no-store' },
        body: encodeJson(value),
        payload: value,
      };
      if (scope) idempotency!.complete(scope, outcome);
      return outcome;
    } catch (error) {
      const clientGone = ctx.signal.aborted && ctx.signal.reason instanceof ApueError && ctx.signal.reason.status === 499;
      const outcome = clientGone ? { ...problemOutcome({ title: 'Client Closed Request', status: 499 }), aborted: true } : problemOutcome(toProblem(error), error);
      if (scope) {
        // Deterministic client errors are stored so a retry gets the same answer; server errors
        // and aborted calls release the key so a retry can execute again.
        if (outcome.status < 500 && !clientGone) idempotency!.complete(scope, outcome);
        else idempotency!.release(scope);
      }
      return outcome;
    }
  }

  async function handleBatch(
    req: Exchange,
    res: Exchange,
    signal: AbortSignal,
    gone: AbortSignal,
    complete: () => void,
  ): Promise<void> {
    const method = req.method;
    if (method !== 'POST' && method !== 'QUERY') throw methodNotAllowed(method, 'QUERY, POST');
    const calls = parseBatch(await readJsonBody(req, maxBodyBytes, method === 'QUERY'));
    if (method === 'QUERY' && calls.some((call) => call.def.effect !== 'safe')) {
      throw new ApueError(422, 'Unprocessable Content', 'a QUERY batch may only contain safe calls');
    }

    // Batches always stream: every lane reports as soon as it completes (TTFB = fastest call).
    const { writer, close } = openStream(req, res, STREAM_HEADERS, frameRenderer, gone, complete);
    const results: Array<Promise<{ ok: boolean; value?: unknown }>> = [];
    for (const [lane, call] of calls.entries()) {
      results.push(
        (async () => {
          const deps = await Promise.all([...call.deps].map((dep) => results[dep]!));
          const failed = [...call.deps].filter((_, i) => !deps[i]!.ok);
          if (failed.length > 0) {
            const problem = { type: ProblemType.FAILED_DEPENDENCY, title: 'Failed Dependency', status: 424, detail: `depends on failed call ${failed.join(', ')}` };
            await writer.end({ status: 424, problem }, lane);
            return { ok: false };
          }
          return runLane(lane, call, (dep) => deps[[...call.deps].indexOf(dep)]!.value, writer, signal, req);
        })(),
      );
    }
    await Promise.all(results);
    close();
  }

  async function runLane(
    lane: number,
    call: BatchCall,
    output: (lane: number) => unknown,
    writer: FrameWriter,
    signal: AbortSignal,
    req: Exchange,
  ): Promise<{ ok: boolean; value?: unknown }> {
    const ctx: CallContext = { op: call.op, signal, headers: req.headers, httpVersion: req.httpVersion, method: req.method };
    try {
      const input = validateInput(call.def, resolveRefs(call.input, output));
      if (call.def.stream === 'none') {
        const outcome = await runUnary(call.op, call.def, input, ctx, call.key);
        if (outcome.status !== 200) {
          await writer.end({ status: outcome.status, problem: outcome.payload as Problem }, lane);
          return { ok: false };
        }
        await writer.msg(outcome.payload, lane);
        await writer.end({ status: 200 }, lane);
        return { ok: true, value: outcome.payload };
      }
      const result = await abortable(Promise.resolve(handlerMap[call.op]!(input, ctx)), signal);
      if (!isAsyncIterable(result)) throw new Error(`handler for streaming op ${call.op} did not return an AsyncIterable`);
      // Race each item against the batch signal so a stuck producer can't outlive the deadline
      // (and with it the whole batch response).
      const iterator = result[Symbol.asyncIterator]();
      try {
        for (let next = await abortable(iterator.next(), signal); !next.done; next = await abortable(iterator.next(), signal)) {
          const pending = writer.msg(validateOutput ? call.def.output.parse(next.value) : next.value, lane);
          if (pending) await pending;
        }
      } catch (error) {
        void iterator.return?.();
        throw error;
      }
      await writer.end({ status: 200 }, lane);
      return { ok: true };
    } catch (error) {
      const problem =
        error instanceof RefError
          ? new ApueError(400, 'Unresolvable Reference', error.message, { type: ProblemType.UNRESOLVABLE_REFERENCE }).problem
          : toProblem(error);
      await writer.end({ status: problem.status, problem }, lane);
      return { ok: false };
    }
  }

  interface BatchCall {
    op: string;
    def: OpDef;
    input: unknown;
    key?: string;
    deps: Set<number>;
  }

  /** Structural validation of a batch before anything executes (all-or-nothing 400). */
  function parseBatch(body: unknown): BatchCall[] {
    const bad = (detail: string) => new ApueError(400, 'Invalid Batch', detail, { type: ProblemType.INVALID_BATCH });
    if (body === null || typeof body !== 'object' || !Array.isArray((body as { calls?: unknown }).calls)) {
      throw bad('expected {"calls": [...]}');
    }
    const raw = (body as { calls: unknown[] }).calls;
    if (raw.length === 0 || raw.length > maxBatchCalls) throw bad(`a batch has 1 to ${maxBatchCalls} calls`);
    return raw.map((entry, lane) => {
      if (entry === null || typeof entry !== 'object') throw bad(`call ${lane} is not an object`);
      const { op: name, in: input, key } = entry as { op?: unknown; in?: unknown; key?: unknown };
      if (typeof name !== 'string' || !Object.hasOwn(api, name)) throw bad(`call ${lane}: unknown operation ${String(name)}`);
      const def = api[name]!;
      if (hasRequestStream(def)) throw bad(`call ${lane}: ${name} has a request stream and cannot be batched`);
      if (key !== undefined && (typeof key !== 'string' || key.length === 0 || key.length > 255)) throw bad(`call ${lane}: invalid key`);
      let deps: Set<number>;
      try {
        deps = collectRefs(input, lane);
      } catch (error) {
        if (error instanceof RefError) throw bad(`call ${lane}: ${error.message}`);
        throw error;
      }
      for (const dep of deps) {
        if (api[(raw[dep] as { op: string }).op]!.stream !== 'none') throw bad(`call ${lane} references streaming call ${dep}`);
      }
      return { op: name, def, input, deps, ...(typeof key === 'string' ? { key } : {}) };
    });
  }

  async function streamResponse(
    req: Exchange,
    res: Exchange,
    items: AsyncIterable<unknown>,
    output: Schema<unknown> | undefined,
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
    const { writer, close } = openStream(req, res, { ...STREAM_HEADERS, 'content-type': renderer.contentType, vary: 'accept' }, renderer, gone, complete);
    let finished = false;
    const finish = (info: EndInfo | undefined) => {
      if (finished) return;
      finished = true;
      void iterator.return?.();
      if (info && !gone.aborted) void writer.end(info);
      close();
    };
    // A deadline or client abort ends the stream at once, even while the producer is stuck; the
    // loop notices `finished` on its next turn. One listener per stream instead of a
    // Promise.race per item (that race was a measurable per-message cost, bench S4).
    const onAbort = () => {
      const problem = toProblem(signal.reason);
      finish(gone.aborted ? undefined : { status: problem.status, problem });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      let next = early.status === 'fulfilled' ? early.value : await first;
      while (!next.done && !finished) {
        const pending = writer.msg(output ? output.parse(next.value) : next.value);
        if (pending) await pending;
        if (finished) break;
        next = await iterator.next();
      }
      finish({ status: 200 });
    } catch (error) {
      const problem = toProblem(error);
      finish(gone.aborted ? undefined : { status: problem.status, problem });
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Commits stream headers and returns a FrameWriter on the (possibly compressed) body. The
   * compressor is flushed after every frame burst, so compression never delays a message.
   */
  function openStream(
    req: Exchange,
    res: Exchange,
    headers: Record<string, string>,
    renderer: Renderer,
    gone: AbortSignal,
    complete: () => void,
  ): { writer: FrameWriter; close(): void } {
    const coding = negotiate(req.headers['accept-encoding'], codings);
    const out: Record<string, string> = codings.length > 0 ? { ...headers, vary: appendVary(headers.vary, 'accept-encoding') } : { ...headers };
    if (coding) out['content-encoding'] = coding;
    res.writeHead(200, out);
    let compressor: Transform | undefined;
    if (coding) {
      compressor = createCompressor(coding);
      compressor.on('error', () => {});
      compressor.pipe(res.sink, { end: false });
    }
    const writer = new FrameWriter(compressor ?? res.sink, {
      renderer,
      coalesceBytes,
      maxBufferedBytes,
      ...(compressor && coding ? { afterFlush: () => flushCompressor(compressor, coding) } : {}),
    });
    writer.startHeartbeat(heartbeatMs);
    return {
      writer,
      close() {
        writer.close();
        if (gone.aborted) return void compressor?.destroy();
        complete();
        if (!compressor) return res.end();
        compressor.once('end', () => res.end());
        compressor.end();
      },
    };
  }

  /**
   * Sends a complete response, compressed when negotiated and worthwhile. A different
   * content-coding is a different representation (RFC 9110 §8.8.3), so the ETag carries it.
   */
  async function sendBody(
    req: Exchange,
    res: Exchange,
    status: number,
    headers: Record<string, string>,
    body: Uint8Array,
    cacheable: boolean,
  ): Promise<void> {
    const compressible = body.byteLength >= minCompressBytes && codings.length > 0;
    const coding = compressible ? negotiate(req.headers['accept-encoding'], codings) : undefined;
    const out: Record<string, string> = compressible ? { ...headers, vary: appendVary(headers.vary, 'accept-encoding') } : { ...headers };
    if (cacheable) {
      out.etag = `"${hash(body).slice(0, 22)}${coding ? `-${coding}` : ''}"`;
      if (ifNoneMatch(req.headers['if-none-match'], out.etag)) {
        const { 'content-type': _, ...notModified } = out;
        return sendBytes(res, 304, notModified);
      }
    }
    let payload = body;
    if (coding) {
      payload = body.byteLength >= 64 * 1024 ? await compressAsync(coding, body) : compressSync(coding, body);
      out['content-encoding'] = coding;
    }
    sendBytes(res, status, out, req.method === 'HEAD' ? undefined : payload, payload.byteLength);
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
      // Wait for 'close' rather than the close() callback: a session the client already closed
      // never calls the callback, which left close() pending forever.
      await Promise.all(
        [...sessions].map(
          (session) =>
            new Promise<void>((resolve) => {
              if (session.destroyed) return resolve();
              session.once('close', () => resolve());
              session.close();
            }),
        ),
      );
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

function parseQueryInput(url: { search: string }): unknown {
  if (url.search === '') return undefined;
  const values = new URLSearchParams(url.search).getAll('i');
  if (values.length > 1) throw new ApueError(400, 'Bad Request', 'query parameter i given more than once');
  if (values.length === 0) return undefined;
  try {
    return JSON.parse(values[0]!);
  } catch {
    throw new ApueError(400, 'Bad Request', 'query parameter i is not valid JSON');
  }
}

async function readJsonBody(req: Exchange, maxBodyBytes: number, query: boolean): Promise<unknown> {
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

async function* readInputStream(req: Exchange): AsyncGenerator<unknown> {
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
  // One-shot API (no Hash object); SHA-256 is hardware-accelerated: ~0.43 ms per MiB (bench S4).
  return cryptoHash('sha256', text, 'base64url');
}

const CORS_ALLOW_METHODS = 'GET, HEAD, POST, QUERY';
const CORS_ALLOW_HEADERS = new Set(['accept', 'authorization', 'content-type', 'idempotency-key', 'if-none-match', 'incremental', Header.TIMEOUT]);
const CORS_EXPOSE_HEADERS = 'etag, apue-replayed, deprecation, sunset, link, retry-after, accept-query, content-encoding';

/**
 * Adds CORS response headers for an allowed Origin and answers preflights. Returns true when the
 * request was a preflight (already answered). Disallowed origins get no CORS headers, so the
 * browser blocks them; their preflights get 403.
 */
function applyCors(req: Exchange, res: Exchange, cors: CorsOptions): boolean {
  const origin = req.headers.origin;
  const allowed = typeof origin === 'string' && (cors.origins === '*' || cors.origins.includes(origin));
  const preflight = req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined;
  if (allowed) {
    res.setHeader('access-control-allow-origin', cors.origins === '*' ? '*' : origin);
    if (cors.origins !== '*') res.setHeader('vary', 'origin');
    if (cors.credentials) res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-expose-headers', CORS_EXPOSE_HEADERS);
    // Lets the page see nextHopProtocol/timings of API requests (Resource Timing).
    res.setHeader('timing-allow-origin', cors.origins === '*' ? '*' : origin);
  }
  if (!preflight) return false;
  if (!allowed) {
    res.send(403, { 'content-type': MediaType.PROBLEM }, encodeJson({ title: 'Forbidden', status: 403, detail: 'origin not allowed' }));
    return true;
  }
  const requested = String(req.headers['access-control-request-headers'] ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const headers: Record<string, string> = {
    'access-control-allow-methods': CORS_ALLOW_METHODS,
    'access-control-allow-headers': requested.filter((h) => CORS_ALLOW_HEADERS.has(h)).join(', '),
    'access-control-max-age': String(cors.maxAge ?? 7200),
  };
  res.send(204, headers);
  return true;
}

function appendVary(existing: string | undefined, field: string): string {
  return existing ? `${existing}, ${field}` : field;
}

function ifNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  // If-None-Match uses weak comparison (RFC 9110 §13.1.2): W/ prefixes are ignored.
  return header.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag);
}

function problemOutcome(problem: Problem, error?: unknown): StoredResponse & { payload: unknown } {
  const headers: Record<string, string> = { 'content-type': MediaType.PROBLEM, 'cache-control': 'no-store' };
  if (error instanceof ApueError) Object.assign(headers, error.headers);
  return { status: problem.status, headers, body: encodeJson(problem), payload: problem };
}

function timeoutSignal(signal: AbortSignal, req: Exchange): AbortSignal {
  const timeoutMs = parseTimeout(req.headers[Header.TIMEOUT]);
  return timeoutMs === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

function sendBytes(
  res: Exchange,
  status: number,
  headers: Record<string, string>,
  body?: Uint8Array,
  contentLength = body?.byteLength,
): void {
  res.send(status, contentLength === undefined || status === 304 ? headers : { ...headers, 'content-length': String(contentLength) }, body);
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
