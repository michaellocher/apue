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
  endFrame,
  FrameError,
  FrameType,
  jsonFrame,
  type EndInfo,
  type Problem,
} from './frame.ts';
import { MemoryIdempotencyStore, type IdempotencyStore, type StoredResponse } from './idempotency.ts';
import { compressAsync, compressSync, createCompressor, DEFAULT_CODINGS, flushCompressor, negotiate, type Coding } from './compression.ts';
import { STATUS_CODES } from 'node:http';
import { onExchange, WsExchange, type Exchange, type WebSocketUpgrade } from './exchange.ts';
import { acceptKey, checkHandshake, WsClose, WsConnection } from './websocket.ts';
import { drained } from './node-streams.ts';
import { ApueError, baseMediaType, checkWindow, Header, isAsyncIterable, isClientGone, isUploadRef, MediaType, ProblemType, WS_INITIAL_WINDOW, WS_SUBPROTOCOL } from './protocol.ts';
export { isClientGone } from './protocol.ts';
import { collectRefs, RefError, resolveRefs } from './refs.ts';
import { ResumeTokens, type ResumeOptions } from './resume.ts';
import { compileSelection, MAX_SELECT_PATHS, project, SelectionError, type Selection } from './select.ts';
import { HTTP_CONVENTIONS, opErrors, opExample, opHttp, PROTOCOL_ERRORS } from './docs.ts';
import { BlobAssembler, blobChunks, decodeFramedValue, messageFrames, splitMessage } from './blobs.ts';
import { containsBytes, containsDownload, isDownloadRef, isDownloadSource, mapBytes, mapDownloads, ValidationError } from './schema.ts';
import { DownloadStore, DOWNLOADS_PATH, serveDownload, type DownloadOptions } from './downloads.ts';
import { handleUpload, UploadStore, UPLOADS_PATH, type UploadOptions } from './uploads.ts';

export type { Exchange } from './exchange.ts';

export interface CallContext {
  readonly op: string;
  /** Aborted when the client goes away or the deadline (`apue-timeout`) passes. */
  readonly signal: AbortSignal;
  readonly headers: http2.IncomingHttpHeaders;
  readonly httpVersion: string;
  readonly method: string;
  /** The caller's identity from the server's `principal` hook (undefined: anonymous or no hook). */
  readonly principal?: string;
  /** Resumable streams: the cursor of the last checkpoint the client received, if resuming. */
  readonly resumeFrom?: string;
  /**
   * Resumable streams: everything yielded so far is covered by `cursor`. Sends a signed CHECKPOINT
   * frame; after a disconnect the client resumes with it and the handler gets `resumeFrom`.
   * Contract: resuming from a cursor must yield the same items in the same order as the original
   * stream did after that checkpoint (the client skips the ones it already has).
   */
  checkpoint(cursor: string): void;
}

const noCheckpoint = () => {
  throw new Error('ctx.checkpoint() needs an op declared with resumable: true');
};

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
  /**
   * WebSocket (T3) receive window granted to each client, re-granted as the handler consumes:
   * bounds server memory per call and caps uploads below window / RTT. Default: streamWindow, the
   * same bound an HTTP/2 request stream gets (1 MiB uploaded at 6.3 MiB/s at 63 ms RTT, 4 MiB at
   * 22.7; HTTP/2 27.2).
   */
  webSocketWindow?: number;
  /** HTTP/2 per-connection receive window. */
  connectionWindow?: number;
  /**
   * SETTINGS_MAX_CONCURRENT_STREAMS. Node's default is unlimited (2³²−1) — a DoS surface. Clients
   * queue (node:http2) or open more connections (undici) beyond it. Default 256.
   */
  maxConcurrentStreams?: number;
  /**
   * Idle HTTP/2 sessions are closed (GOAWAY) after this long, and destroyed if still idle one
   * more period later (a GOAWAY waits for open streams, which a stuck peer never finishes);
   * heartbeats count as activity. 0 disables. Default 120 s.
   */
  idleTimeoutMs?: number;
  /**
   * `close()` lets calls in flight finish for this long; then the rest end with a retryable 503
   * (streams get an END frame, so clients retry or resume elsewhere) and remaining connections
   * are dropped. Infinity waits for every call. Default 10 s.
   */
  shutdownGraceMs?: number;
  /**
   * This replica's name, prefixed to upload and download ids (`/$uploads/eu-1.<id>`): uploads and
   * download resources live in the replica that created them, and a load balancer routes their
   * URLs by this prefix (docs/deployment.md). 1–32 characters: letters, digits, `-`.
   */
  instance?: string;
  /** A unary request body must arrive within this time, else 408 (slow-body protection). Default 30 s. */
  bodyTimeoutMs?: number;
  /**
   * Maximum nesting of incoming JSON (bodies, `?i=`, stream messages, batches). Deeper input is a
   * 400 before parsing — deeply nested values overflowed the stack of recursive helpers (500s at
   * ~10,000 levels before this limit). Default 64.
   */
  maxJsonDepth?: number;
  /**
   * Resumable uploads at `/$uploads` (draft-ietf-httpbis-resumable-upload, research/06): op inputs
   * reference them as { "$upload": id } where the schema says t.bytes(). Off by default (it is
   * storage any client can fill); required by ops with bytes in a unary input.
   */
  uploads?: UploadOptions;
  /**
   * Download resources for t.download() outputs (`/$downloads/…`, Range support, short-lived
   * unguessable URLs). Enabled automatically for APIs that have such outputs.
   */
  downloads?: DownloadOptions;
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
  /**
   * Who is calling: a stable identity (user or account id — not the credential itself, which
   * changes on every token refresh), or undefined for anonymous callers. apü defines no
   * authentication; this hook connects the application's. Idempotency keys, uploads (visibility
   * and quota) and resume tokens are scoped to it, and handlers get it as `ctx.principal`.
   * Called once per op, batch or upload request (not for the manifest, preflights or `fallback`);
   * an ApueError it throws (e.g. 401) is the response. Over WebSocket (tier T3) `headers` carries
   * the credentials offered as an `apue.auth.` subprotocol as `authorization`.
   * Without the hook, these scopes are the raw `Authorization` header (a refreshed token is
   * another scope), resume tokens are not bound to a caller, and upload quotas count per address.
   */
  principal?: (request: PrincipalRequest) => string | undefined | Promise<string | undefined>;
  /** Resume tokens: share `secret` between replicas so any instance can resume a stream. */
  resume?: ResumeOptions;
  /**
   * Handles paths that are not operations (static assets, health checks) — e.g. to serve the web
   * app from the same origin, which needs no CORS preflights. Return true when handled.
   */
  fallback?: (exchange: Exchange) => boolean | Promise<boolean>;
}

export interface PrincipalRequest {
  headers: http2.IncomingHttpHeaders;
  remoteAddress: string | undefined;
  /**
   * The call's method and path with query, as a proof of possession (e.g. a DPoP proof's
   * `htm`/`htu`) would bind them. A WebSocket call reports POST — its logical method, what the
   * client signs whichever tier carries the call — and its path (query: transport parameters).
   */
  method: string;
  url: string;
}

/** Who a request is from, resolved once per request (see `principal`). */
interface Caller {
  /** Scope for idempotency keys and uploads. */
  scope: string;
  /** The principal hook's answer (undefined: anonymous, or no hook). */
  principal: string | undefined;
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
/** RFC 9727 API catalog (linkset) pointing at the manifest, for generic discovery. */
export const CATALOG_PATH = '/.well-known/api-catalog';
const CATALOG_TYPE = 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';
// Op names start with a letter, so this never collides with an op — and `/` stays free for
// serving the web app from the same origin.
export const BATCH_PATH = '/$batch';
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
  render(type: number, payload: Uint8Array, lane: number, flags?: number): Uint8Array;
  /** Renders a JSON-payload frame without an intermediate payload buffer. */
  renderJson(type: number, value: unknown, lane: number): Uint8Array;
}

export const frameRenderer: Renderer = {
  contentType: MediaType.STREAM_JSON,
  render: (type, payload, lane, flags = 0) => encodeFrame(type, payload, lane, flags),
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
    // EventSource remembers `id` and sends it back as Last-Event-ID when it reconnects.
    if (type === FrameType.CHECKPOINT) return textEncoder.encode(`id: ${Buffer.from(payload).toString('utf8')}\n\n`);
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
  /** One waiter for all writes while the sink needs draining (each drained() adds 3 listeners). */
  #drain: Promise<void> | undefined;

  constructor(sink: Writable, options: FrameWriterOptions = {}) {
    this.#sink = sink;
    this.#renderer = options.renderer ?? frameRenderer;
    this.#coalesceBytes = options.coalesceBytes ?? 16 * 1024;
    this.#maxBufferedBytes = options.maxBufferedBytes ?? 256 * 1024;
    this.#afterFlush = options.afterFlush;
  }

  // The write methods return a promise only while the sink needs draining, so producers can skip
  // an `await` (one microtask) per message: `const p = writer.msg(v); if (p) await p;`.
  frame(type: number, payload: Uint8Array, lane = 0, flags = 0): Promise<void> | undefined {
    return this.#push(this.#renderer.render(type, payload, lane, flags));
  }

  /** A message whose schema contains bytes: BLOB frames for each Uint8Array, then the MSG. */
  message(value: unknown, lane = 0): Promise<void> | undefined {
    const { json, blobs } = splitMessage(value);
    let pending: Promise<void> | undefined;
    for (const blob of blobs) {
      for (const { chunk, flags } of blobChunks(blob)) pending = this.frame(FrameType.BLOB, chunk, lane, flags) ?? pending;
    }
    return this.msg(json, lane) ?? pending;
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
    if (!mustWait) return undefined;
    // Blob chunks, heartbeats and checkpoints can each hit this while blocked: share one waiter
    // (a waiter per call put 11+ listeners on a slow stream — MaxListenersExceededWarning).
    return (this.#drain ??= drained(this.#sink).finally(() => (this.#drain = undefined)));
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
    webSocketWindow = Math.max(WS_INITIAL_WINDOW, streamWindow), // HTTP/2 allows smaller windows than WS credit
    connectionWindow = 32 * 1024 * 1024,
    validateOutput = true,
    maxBatchCalls = 64,
    maxBufferedBytes = 256 * 1024,
    maxConcurrentStreams = 256,
    idleTimeoutMs = 120_000,
    shutdownGraceMs = 10_000,
    bodyTimeoutMs = 30_000,
    maxJsonDepth = 64,
  } = options;
  const codings = options.compression === false ? [] : (options.compression?.codings ?? DEFAULT_CODINGS);
  const minCompressBytes = options.compression === false ? Infinity : (options.compression?.minBytes ?? 1024);
  const cors = options.cors;
  const resumeTokens = new ResumeTokens(options.resume);
  if (!(shutdownGraceMs >= 0)) throw new RangeError(`shutdownGraceMs must be ≥ 0 (or Infinity), got ${shutdownGraceMs}`);
  /** Calls in flight, by their call controller: `close()` aborts what outlives the grace period. */
  const inflight = new Set<AbortController>();
  let drainedWaiter: (() => void) | undefined;
  if (cors?.credentials && cors.origins === '*') throw new Error('cors: credentials require an explicit origin list');
  checkWindow('webSocketWindow', webSocketWindow);
  if (options.instance !== undefined && !/^[A-Za-z0-9-]{1,32}$/.test(options.instance)) throw new RangeError(`instance must be 1–32 letters, digits or '-', got ${JSON.stringify(options.instance)}`);
  const uploads = options.uploads ? new UploadStore({ ...options.uploads, ...(options.instance === undefined ? {} : { instance: options.instance }) }) : undefined;
  const downloads =
    Object.values(api).some((def) => containsDownload(def.output)) || options.downloads ? new DownloadStore({ ...options.downloads, ...(options.instance === undefined ? {} : { instance: options.instance }) }) : undefined;
  /** t.download() values in an output → references to download resources. */
  const withDownloads = (def: OpDef, value: unknown): unknown =>
    downloads && containsDownload(def.output) ? mapDownloads(def.output, value, (v) => (isDownloadSource(v) ? downloads.register(v) : v)) : value;
  for (const [name, def] of Object.entries(api)) {
    if (!hasRequestStream(def) && containsBytes(def.input) && !uploads) {
      throw new Error(`${name} has bytes in a unary input: they arrive as upload references, enable options.uploads`);
    }
  }
  const principalHook = options.principal;
  const toCaller = (principal: unknown): Caller => {
    if (principal === undefined || principal === null) return { scope: 'anonymous', principal: undefined };
    if (typeof principal !== 'string' || principal === '') throw new TypeError('principal() must return a non-empty string or undefined');
    return { scope: `principal:${principal}`, principal };
  };
  /** Who is asking (see `principal`). Without a hook the scope is hashed only if something needs it. */
  const identify = (req: Exchange): Caller | Promise<Caller> => {
    if (!principalHook) {
      const authorization = String(req.headers.authorization ?? '');
      let scope: string | undefined;
      return {
        principal: undefined,
        get scope() {
          return (scope ??= `credentials:${hash(authorization)}`);
        },
      };
    }
    const answer = principalHook({ headers: req.headers, remoteAddress: req.remoteAddress, method: req.method, url: req.url });
    return answer instanceof Promise ? answer.then(toCaller) : toCaller(answer);
  };
  /**
   * Upload references → bytes at t.bytes() positions (400 with the field path if one doesn't
   * resolve), plus the input's identity for idempotency and resume tokens: references replaced by
   * the content's SHA-256 — the same bytes uploaded again (new id) are the same input.
   */
  const resolveUploads = async (def: OpDef, input: unknown, scope: string, releases: Array<() => Promise<void>>): Promise<{ input: unknown; identity: unknown }> => {
    if (!uploads || !containsBytes(def.input)) return { input, identity: input };
    const digests = new Map<string, string>();
    const unusable = (path: string) =>
      new ApueError(400, 'Validation Failed', 'input does not match the schema', { type: ProblemType.VALIDATION, fields: [{ path, message: 'unknown, incomplete or expired upload' }] });
    const resolved = await mapBytes(def.input, input, async (value, path, kind) => {
      if (!isUploadRef(value)) return value; // validation reports it
      if (kind === 'file') {
        // t.file(): a stream from the upload store — never read into memory here; readable until
        // the request is done (released in handle()), even if the upload is deleted meanwhile.
        const opened = await uploads.openFile(value.$upload, scope);
        if (!opened) throw unusable(path);
        releases.push(opened.release);
        digests.set(value.$upload, opened.value.sha256);
        return opened.value;
      }
      const upload = await uploads.resolve(value.$upload, scope);
      if (!upload) throw unusable(path);
      digests.set(value.$upload, upload.digest);
      return upload.bytes;
    });
    const identity = await mapBytes(def.input, input, (value) => (isUploadRef(value) ? { sha256: digests.get(value.$upload) } : value));
    return { input: resolved, identity };
  };
  const idempotency = options.idempotency === false ? undefined : (options.idempotency ?? new MemoryIdempotencyStore());
  const handlerMap = handlers as unknown as Record<string, AnyHandler>;
  for (const name of Object.keys(api)) {
    if (typeof handlerMap[name] !== 'function') throw new Error(`missing handler for ${name}`);
  }
  // Built once: docs derived from the definitions (research/08) plus this server's limits.
  const manifest = encodeJson({
    ...buildManifest(api),
    limits: {
      maxBodyBytes,
      maxJsonDepth,
      maxBatchCalls,
      maxSelectPaths: MAX_SELECT_PATHS,
      bodyTimeoutMs,
      heartbeatMs,
      ...(uploads
        ? { uploads: { path: UPLOADS_PATH, maxBytes: uploads.maxSize, clientBytes: uploads.scopeBytes, clientUploads: uploads.scopeUploads, maxAgeSeconds: Math.floor(uploads.ttlMs / 1000) } }
        : {}),
    },
  });

  const serverOptions: http2.SecureServerOptions & { connectionWindowSize?: number } = {
    key: options.key,
    cert: options.cert,
    allowHTTP1: true,
    // enableConnectProtocol: RFC 8441 WebSockets over HTTP/2 (tier T3).
    settings: { initialWindowSize: streamWindow, enableConnectProtocol: true, maxConcurrentStreams },
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
    // Node's default is no idle timeout at all: idle connections would be held forever.
    if (idleTimeoutMs > 0) {
      // Node fires a session timeout once: re-arm it to destroy a session still idle after GOAWAY.
      session.setTimeout(idleTimeoutMs, () => {
        session.close();
        session.setTimeout(idleTimeoutMs, () => session.destroy());
      });
    }
  });
  const webSockets = new Set<WsConnection>();
  onExchange(server, (exchange) => void handle(exchange, exchange), acceptWebSocket);

  /** Tier T3: validates the handshake, then runs the call over the WebSocket like any request. */
  function acceptWebSocket(upgrade: WebSocketUpgrade): void {
    const received = upgrade.kind === 'h2' ? upgrade.headers : upgrade.req.headers;
    const authority = String(received[':authority'] ?? received.host ?? '');
    // A browser sends cookies (and cached HTTP credentials) with every WebSocket handshake — no CORS
    // check stops it. As with fetch, a cross-origin call gets them only if CORS allows credentials;
    // otherwise any site could call with the user's session (cross-site WebSocket hijacking).
    // Credentials the page offers explicitly (an apue.auth. subprotocol) are not ambient.
    const crossOrigin = typeof received.origin === 'string' && received.origin !== `https://${authority}`;
    const { cookie: _cookie, authorization: _authorization, ...withoutAmbient } = received;
    const headers = crossOrigin && !cors?.credentials ? withoutAmbient : received;
    const check = checkHandshake(headers, (origin) =>
      cors ? cors.origins === '*' || cors.origins.includes(origin) : origin === `https://${authority}`,
    );
    const key = headers['sec-websocket-key'];
    if (upgrade.kind === 'h1' && check.ok && (typeof key !== 'string' || Buffer.from(key, 'base64').byteLength !== 16)) {
      Object.assign(check, { ok: false, status: 400, reason: 'invalid Sec-WebSocket-Key' });
    }
    if (!check.ok) {
      if (upgrade.kind === 'h2') {
        upgrade.stream.respond({ ':status': check.status, ...(check.status === 426 ? { 'sec-websocket-version': '13' } : {}) });
        upgrade.stream.end(check.reason);
      } else {
        const extra = check.status === 426 ? 'Sec-WebSocket-Version: 13\r\n' : '';
        upgrade.socket.end(`HTTP/1.1 ${check.status} ${STATUS_CODES[check.status]}\r\nConnection: close\r\n${extra}\r\n`);
      }
      return;
    }
    let conn: WsConnection;
    let path: string;
    if (upgrade.kind === 'h2') {
      upgrade.stream.respond({ ':status': 200, 'sec-websocket-protocol': WS_SUBPROTOCOL });
      conn = new WsConnection(upgrade.stream, { window: webSocketWindow });
      path = String(upgrade.headers[':path'] ?? '/');
    } else {
      upgrade.socket.setNoDelay(true);
      upgrade.socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key as string)}\r\nSec-WebSocket-Protocol: ${WS_SUBPROTOCOL}\r\n\r\n`,
      );
      conn = new WsConnection(upgrade.socket, { head: upgrade.head, window: webSocketWindow });
      path = upgrade.req.url ?? '/';
    }
    webSockets.add(conn);
    conn.onClose(() => webSockets.delete(conn));
    // The call sees subprotocol credentials as `authorization` (and a proof as `dpop`), like on
    // every other tier, and never the subprotocols carrying them (they'd end up in header logs).
    const { 'sec-websocket-protocol': _offered, ...rest } = headers;
    const callHeaders = {
      ...rest,
      'sec-websocket-protocol': check.protocols!.join(', '),
      ...(check.authorization === undefined ? {} : { authorization: check.authorization }),
      ...(check.dpop === undefined ? {} : { dpop: check.dpop }),
    };
    const exchange = new WsExchange(conn, path, callHeaders, upgrade.kind === 'h2' ? '2.0' : '1.1');
    if (check.credentialError !== undefined) {
      // Nothing runs; the client gets a status and a reason instead of a bare failed connection.
      const problem = new ApueError(400, 'Bad Request', check.credentialError).problem;
      return exchange.send(400, {}, encodeJson(problem));
    }
    void handle(exchange, exchange);
  }

  // `req` and `res` are the same Exchange; the two names keep request- and response-side code readable.
  async function handle(req: Exchange, res: Exchange): Promise<void> {
    // Own completion flag: 'close' fires for completed and for reset streams alike.
    const clientGone = new AbortController();
    // The call's own signal: aborted when the client goes, and by close() after its grace period
    // (then with a 503 that is still sent — clientGone stays unaborted).
    const call = new AbortController();
    inflight.add(call);
    const releases: Array<() => Promise<void>> = []; // t.file() inputs opened for this request
    let completed = false;
    const complete = () => (completed = true);
    res.onClose(() => {
      if (completed) return;
      const gone = new ApueError(499, 'Client Closed Request');
      clientGone.abort(gone);
      call.abort(gone);
    });
    let signal = call.signal;
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
      if (url.pathname === CATALOG_PATH) {
        if (method !== 'GET' && !head) throw methodNotAllowed(method, 'GET, HEAD');
        complete();
        const authority = String(req.headers[':authority'] ?? req.headers.host ?? 'localhost');
        const origin = `https://${authority}`;
        const catalog = encodeJson({
          linkset: [{ anchor: `${origin}/`, 'service-desc': [{ href: `${origin}${MANIFEST_PATH}`, type: MediaType.JSON }] }],
        });
        // RFC 9727 §2: HEAD (and GET) responses include a Link header to the catalog.
        return await sendBody(req, res, 200, { 'content-type': CATALOG_TYPE, link: `<${CATALOG_PATH}>; rel="api-catalog"`, 'cache-control': 'no-cache' }, catalog, true);
      }
      if (url.pathname === MANIFEST_PATH) {
        if (method !== 'GET' && !head) throw methodNotAllowed(method, 'GET, HEAD');
        complete();
        return await sendBody(req, res, 200, { 'content-type': MediaType.JSON, 'cache-control': 'no-cache' }, manifest, true);
      }
      if (url.pathname === UPLOADS_PATH || url.pathname.startsWith(`${UPLOADS_PATH}/`)) {
        if (!uploads) throw new ApueError(404, 'Not Found', 'uploads are not enabled on this server');
        // Uploads are plain HTTP requests (resumable by design); a WebSocket call has no address to
        // count against and nothing to resume.
        if (req instanceof WsExchange) throw new ApueError(400, 'Bad Request', 'uploads use plain HTTP requests, not WebSocket');
        const caller = await identify(req);
        // Quotas need an identity the application vouches for: without the hook, a made-up
        // Authorization header would buy a fresh quota — so it is the address then.
        const quota = caller.principal !== undefined ? caller.scope : `addr:${req.remoteAddress ?? ''}`;
        const response = await handleUpload(req, uploads, caller.scope, quota, url.pathname);
        complete();
        return void res.send(response.status, response.headers, head ? undefined : response.body);
      }
      if (url.pathname.startsWith(`${DOWNLOADS_PATH}/`)) {
        if (!downloads) throw new ApueError(404, 'Not Found', 'this server has no downloads');
        await serveDownload(req, res, downloads, url.pathname, clientGone.signal);
        complete();
        return;
      }
      if (url.pathname === BATCH_PATH) return await handleBatch(req, res, timeoutSignal(signal, req), clientGone.signal, complete, await identify(req), releases);
      const opName = decodePathSegment(url.pathname.slice(1));
      const def: OpDef | undefined = Object.hasOwn(api, opName) ? api[opName] : undefined;
      if (!def && options.fallback && (await options.fallback(req))) {
        complete();
        return;
      }
      if (!def) throw new ApueError(404, 'Unknown Operation', opName, { type: ProblemType.UNKNOWN_OPERATION });
      const identified = identify(req);
      const caller = identified instanceof Promise ? await identified : identified; // no await unless the hook is async
      const read = isCacheableRead(def);
      const allow = read ? 'GET, HEAD, QUERY, POST' : 'POST';
      if (!allow.split(', ').includes(method)) throw methodNotAllowed(method, allow);
      if (def.deprecated) {
        for (const [name, value] of Object.entries(deprecationHeaders(def.deprecated))) res.setHeader(name, value);
      }
      if (read) res.setHeader('accept-query', `"${MediaType.JSON}"`);
      const selection = selectionFor(opName, def, url.search);

      signal = timeoutSignal(signal, req);

      let input: unknown;
      if (method === 'GET' || head) {
        input = parseQueryInput(url, maxJsonDepth);
      } else if (hasRequestStream(def)) {
        if (baseMediaType(req.headers['content-type']) !== MediaType.STREAM_JSON) {
          throw new ApueError(415, 'Unsupported Media Type', `${opName} expects ${MediaType.STREAM_JSON}`);
        }
        input = validatedStream(readInputStream(req, maxBodyBytes, containsBytes(def.input), maxJsonDepth), def);
      } else {
        input = await readJsonBody(req, maxBodyBytes, method === 'QUERY', bodyTimeoutMs, maxJsonDepth);
      }
      // Identity for idempotency and resume tokens: the input with upload references, not the
      // resolved bytes (canonical JSON of a 64 MiB Uint8Array would be a huge object).
      let identity: unknown;
      if (!hasRequestStream(def)) {
        const resolved = await resolveUploads(def, input, caller.scope, releases);
        input = validateInput(def, resolved.input);
        identity = containsBytes(def.input) ? resolved.identity : input;
      }

      // Resumable streams: checkpoints become signed tokens bound to this op and input.
      let resumeFrom: string | undefined;
      let checkpoint: (cursor: string) => void = noCheckpoint;
      const checkpoints: string[] = [];
      let emitCheckpoint: ((token: string) => void) | undefined;
      if (def.resumable) {
        // 128 bits are plenty to bind a token to its input and keep tokens compact. With a
        // principal hook also to the caller: a stream's identity includes who is asking (the
        // raw Authorization would invalidate tokens on every refresh, so not without the hook).
        const bound = principalHook ? `${caller.scope}\n${canonicalJson(identity ?? null)}` : canonicalJson(identity ?? null);
        const inputHash = hash(bound).slice(0, 22);
        const token = req.headers[Header.RESUME] ?? req.headers['last-event-id'];
        if (typeof token === 'string' && token !== '') resumeFrom = resumeTokens.verify(token, opName, inputHash);
        checkpoint = (cursor) => {
          const issued = resumeTokens.issue(opName, inputHash, cursor);
          if (emitCheckpoint) emitCheckpoint(issued);
          else checkpoints.push(issued); // before the stream is open: sent right after the headers
        };
      }
      const ctx: CallContext = {
        op: opName,
        signal,
        headers: req.headers,
        httpVersion: req.httpVersion,
        method,
        ...(caller.principal === undefined ? {} : { principal: caller.principal }),
        checkpoint,
        ...(resumeFrom === undefined ? {} : { resumeFrom }),
      };
      if (!hasResponseStream(def)) {
        // Keys apply to plain unary calls only: a request stream cannot be fingerprinted or replayed.
        const keyHeader = req.headers[IDEMPOTENCY_KEY];
        const keyed = typeof keyHeader === 'string' && def.effect !== 'safe' && def.stream === 'none';
        const key = keyed ? parseIdempotencyKey(keyHeader) : undefined;
        const outcome = await runUnary(opName, def, input, ctx, caller, key, selection, identity);
        if (outcome.aborted) return;
        complete();
        if (outcome.status === 200 && read) {
          return await sendBody(req, res, 200, { 'content-type': outcome.headers['content-type']!, ...cacheHeaders(def) }, outcome.body, true);
        }
        if (def.invalidates?.length && outcome.status < 400) res.setHeader('cache-group-invalidation', sfStringList(def.invalidates));
        const headers = outcome.replayed ? { ...outcome.headers, [REPLAYED]: '?1' } : outcome.headers;
        return await sendBody(req, res, outcome.status, headers, outcome.body, false);
      }

      if (head) {
        complete();
        return res.send(200, { ...STREAM_HEADERS, vary: 'accept' });
      }
      const result = await abortable(Promise.resolve(handlerMap[opName]!(input, ctx)), signal);
      if (!isAsyncIterable(result)) throw new Error(`handler for streaming op ${opName} did not return an AsyncIterable`);
      const shape = outputShaper(def, selection);
      return await streamResponse(
        req,
        res,
        result,
        shape,
        signal,
        clientGone.signal,
        complete,
        (writer) => {
          for (const token of checkpoints.splice(0)) void writer.frame(FrameType.CHECKPOINT, textEncoder.encode(token));
          emitCheckpoint = (token) => void writer.frame(FrameType.CHECKPOINT, textEncoder.encode(token));
        },
        containsBytes(def.output),
      );
    } catch (error) {
      if (clientGone.signal.aborted) return;
      const problem = toProblem(error);
      complete();
      if (res.headersSent) return void res.end();
      const outcome = problemOutcome(problem, error);
      await sendBody(req, res, outcome.status, outcome.headers, outcome.body, false);
    } finally {
      for (const release of releases) void release();
      inflight.delete(call);
      if (inflight.size === 0) drainedWaiter?.();
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
  async function runUnary(
    opName: string,
    def: OpDef,
    input: unknown,
    ctx: CallContext,
    caller: Caller,
    key: string | undefined,
    selection?: Selection,
    identity: unknown = input,
  ): Promise<Outcome> {
    let scope: string | undefined;
    if (key !== undefined && idempotency && def.effect !== 'safe') {
      scope = `${opName}\n${caller.scope}\n${key}`;
      const claiming = idempotency.begin(scope, hash(canonicalJson(identity ?? null)));
      const claim = claiming instanceof Promise ? await claiming : claiming; // no await for the in-memory store
      if (claim.state === 'replay') {
        const stored = claim.response;
        const framed = baseMediaType(stored.headers['content-type']) === MediaType.STREAM_JSON;
        const payload = framed ? decodeFramedValue(stored.body) : decodeJson(stored.body);
        if (downloads && containsDownload(def.output) && stored.status === 200) {
          // The stored response's download URLs live minutes: refresh them, or say they're gone
          // (never hand out a dead link, never run the operation twice).
          let expired = false;
          const refreshed = mapDownloads(def.output, payload, (ref) => (isDownloadRef(ref) ? (downloads.refresh(ref) ?? ((expired = true), ref)) : ref));
          if (expired) {
            return problemOutcome(
              new ApueError(410, 'Download Expired', 'the stored result of this Idempotency-Key refers to a download that has expired; the operation was not run again', {
                type: ProblemType.DOWNLOAD_EXPIRED,
              }).problem,
            );
          }
          const body = framed ? concatBytes([...messageFrames(refreshed), endFrame({ status: 200 })]) : encodeJson(refreshed);
          return { ...stored, body, payload: refreshed, replayed: true };
        }
        return { ...stored, payload, replayed: true };
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
      const validated = (validateOutput ? def.output.parse(result) : result) ?? null;
      const value = withDownloads(def, selection ? project(validated, selection) : validated);
      const outcome: Outcome = {
        status: 200,
        // A JSON body can't carry bytes: such outputs are answered framed (BLOB frames + MSG + END)
        // — the same bytes are stored for Idempotency-Key replays.
        headers: { 'content-type': containsBytes(def.output) ? MediaType.STREAM_JSON : MediaType.JSON, 'cache-control': 'no-store' },
        body: containsBytes(def.output) ? concatBytes([...messageFrames(value), endFrame({ status: 200 })]) : encodeJson(value),
        payload: value,
      };
      const recorded = scope ? settleKey(idempotency!.complete(scope, outcome)) : undefined;
      if (recorded) await recorded;
      return outcome;
    } catch (error) {
      const clientGone = ctx.signal.aborted && ctx.signal.reason instanceof ApueError && ctx.signal.reason.status === 499;
      const outcome = clientGone ? { ...problemOutcome({ title: 'Client Closed Request', status: 499 }), aborted: true } : problemOutcome(toProblem(error), error);
      if (scope) {
        // Deterministic client errors are stored so a retry gets the same answer; server errors
        // and aborted calls release the key so a retry can execute again.
        const settled = settleKey(outcome.status < 500 && !clientGone ? idempotency!.complete(scope, outcome) : idempotency!.release(scope));
        if (settled) await settled;
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
    caller: Caller,
    releases: Array<() => Promise<void>>,
  ): Promise<void> {
    const method = req.method;
    if (method !== 'POST' && method !== 'QUERY') throw methodNotAllowed(method, 'QUERY, POST');
    const calls = parseBatch(await readJsonBody(req, maxBodyBytes, method === 'QUERY', bodyTimeoutMs, maxJsonDepth));
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
          return runLane(lane, call, (dep) => deps[[...call.deps].indexOf(dep)]!.value, writer, signal, req, caller, releases);
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
    caller: Caller,
    releases: Array<() => Promise<void>>,
  ): Promise<{ ok: boolean; value?: unknown }> {
    // Batch lanes are not resumable (a batch is one request); checkpoints are ignored there.
    const ctx: CallContext = {
      op: call.op,
      signal,
      headers: req.headers,
      httpVersion: req.httpVersion,
      method: req.method,
      ...(caller.principal === undefined ? {} : { principal: caller.principal }),
      checkpoint: () => {},
    };
    try {
      const resolved = await resolveUploads(call.def, resolveRefs(call.input, output), caller.scope, releases);
      const input = validateInput(call.def, resolved.input);
      if (call.def.stream === 'none') {
        const outcome = await runUnary(call.op, call.def, input, ctx, caller, call.key, call.selection, containsBytes(call.def.input) ? resolved.identity : input);
        if (outcome.status !== 200) {
          await writer.end({ status: outcome.status, problem: outcome.payload as Problem }, lane);
          return { ok: false };
        }
        await (containsBytes(call.def.output) ? writer.message(outcome.payload, lane) : writer.msg(outcome.payload, lane));
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
          const item = call.shape ? call.shape(next.value) : next.value;
          const pending = containsBytes(call.def.output) ? writer.message(item, lane) : writer.msg(item, lane);
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
    selection?: Selection;
    shape?: (item: unknown) => unknown;
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
      const { op: name, in: input, key, select } = entry as { op?: unknown; in?: unknown; key?: unknown; select?: unknown };
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
      if (select !== undefined && typeof select !== 'string') throw bad(`call ${lane}: select must be a string`);
      let selection: Selection | undefined;
      try {
        selection = select === undefined ? undefined : compileSelection(def.output, select);
      } catch (error) {
        if (error instanceof SelectionError) throw bad(`call ${lane}: ${error.message}`);
        throw error;
      }
      const shape = outputShaper(def, selection);
      return { op: name, def, input, deps, ...(typeof key === 'string' ? { key } : {}), ...(selection ? { selection } : {}), ...(shape ? { shape } : {}) };
    });
  }

  async function streamResponse(
    req: Exchange,
    res: Exchange,
    items: AsyncIterable<unknown>,
    shape: ((item: unknown) => unknown) | undefined,
    signal: AbortSignal,
    gone: AbortSignal,
    complete: () => void,
    onOpen?: (writer: FrameWriter) => void,
    blobs = false,
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
    onOpen?.(writer);
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
        const item = shape ? shape(next.value) : next.value;
        const pending = blobs ? writer.message(item) : writer.msg(item);
        if (pending) await pending;
        if (finished) break;
        next = await iterator.next();
      }
      finish({ status: 200 });
    } catch (error) {
      const problem = toProblem(error); // logs real failures even when the client is already gone
      finish(gone.aborted ? undefined : { status: problem.status, problem });
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  // Compiled selections per op and spec (bounded cache: specs come from clients).
  const selections = new Map<string, Selection>();

  /** `?s=a,b.c` → validated selection (400 invalid-selection for unknown fields). */
  function selectionFor(opName: string, def: OpDef, search: string): Selection | undefined {
    if (!search.includes('s=')) return undefined;
    const spec = new URLSearchParams(search).get('s');
    if (spec === null) return undefined;
    const cacheKey = `${opName}\n${spec}`;
    let selection = selections.get(cacheKey);
    if (!selection) {
      try {
        selection = compileSelection(def.output, spec);
      } catch (error) {
        if (error instanceof SelectionError) throw new ApueError(400, 'Invalid Selection', error.message, { type: ProblemType.INVALID_SELECTION });
        throw error;
      }
      if (selections.size >= 1000) selections.clear();
      selections.set(cacheKey, selection);
    }
    return selection;
  }

  /** Per-item output handling for streams: validate (strip unknown fields), then project. */
  function outputShaper(def: OpDef, selection: Selection | undefined): ((item: unknown) => unknown) | undefined {
    if (!validateOutput && !selection && !containsDownload(def.output)) return undefined;
    return (item) => {
      const validated = validateOutput ? def.output.parse(item) : item;
      return withDownloads(def, selection ? project(validated, selection) : validated);
    };
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
    async listen(port = 0, host = '127.0.0.1') {
      await uploads?.init(); // persistent uploads are restored before the first request
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
      for (const conn of webSockets) conn.close(WsClose.GOING_AWAY, 'server shutting down');
      // Graceful GOAWAY for h2 sessions: no new streams, open ones may finish (what is left after
      // the grace period goes with its socket, below). Wait for 'close'
      // rather than the close() callback: a session the client already closed never calls the
      // callback, which left close() pending forever.
      const sessionsClosed = Promise.all(
        [...sessions].map(
          (session) =>
            new Promise<void>((resolve) => {
              if (session.destroyed) return resolve();
              session.once('close', () => resolve());
              session.close();
            }),
        ),
      );
      const callsDone = new Promise<void>((resolve) => {
        if (inflight.size === 0) return resolve();
        drainedWaiter = resolve;
      });
      const graceful = Promise.all([sessionsClosed, callsDone]);
      if (!(await within(graceful, shutdownGraceMs))) {
        // Grace over: what is still running ends with a retryable 503 — written as the response
        // or END frame where the client is still there — then gets a moment to be flushed.
        const reason = new ApueError(503, 'Service Unavailable', 'server shutting down', { retryable: true }, { 'retry-after': '0' });
        for (const call of inflight) call.abort(reason);
        await within(graceful, 1_000);
      }
      for (const socket of sockets) socket.destroy();
      await closed;
      await uploads?.close();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Manifest (§11): machine-readable contract, served at /.well-known/apue.

export function buildManifest(api: Api): Record<string, unknown> {
  return {
    apue: PROTOCOL_VERSION,
    // Derived documentation (research/08): conventions and the errors every op can get.
    http: HTTP_CONVENTIONS,
    errors: PROTOCOL_ERRORS,
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
          ...(def.resumable ? { resumable: true } : {}),
          ...(def.invalidates?.length ? { invalidates: [...def.invalidates] } : {}),
          http: opHttp(name, def),
          errors: opErrors(def),
          ...exampleField(def),
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

function exampleField(def: OpDef): { example?: { input?: unknown; output?: unknown } } {
  const example = opExample(def);
  return Object.keys(example).length > 0 ? { example } : {};
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

function parseQueryInput(url: { search: string }, maxDepth: number): unknown {
  if (url.search === '') return undefined;
  const values = new URLSearchParams(url.search).getAll('i');
  if (values.length > 1) throw new ApueError(400, 'Bad Request', 'query parameter i given more than once');
  if (values.length === 0) return undefined;
  try {
    checkJsonDepth(values[0]!, maxDepth);
    return JSON.parse(values[0]!);
  } catch {
    throw new ApueError(400, 'Bad Request', 'query parameter i is not valid JSON');
  }
}

async function readJsonBody(req: Exchange, maxBodyBytes: number, query: boolean, timeoutMs: number, maxDepth: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ApueError(408, 'Request Timeout', `request body not received within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([readJsonBodyNow(req, maxBodyBytes, query, maxDepth), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonBodyNow(req: Exchange, maxBodyBytes: number, query: boolean, maxDepth: number): Promise<unknown> {
  const type = baseMediaType(req.headers['content-type']);
  // RFC 10008 §2: servers MUST fail a QUERY whose Content-Type is missing.
  if (query && !type) throw new ApueError(400, 'Bad Request', 'QUERY requires a Content-Type');
  // Reject before reading: some bodies only end when the connection does (WebSocket, tier T3).
  if (type && type !== MediaType.JSON) throw new ApueError(415, 'Unsupported Media Type', `expected ${MediaType.JSON}, got ${type}`);
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
    const bytes = concatBytes(chunks, size);
    checkJsonDepth(bytes, maxDepth);
    return decodeJson(bytes);
  } catch {
    throw new ApueError(400, 'Bad Request', 'body is not valid JSON');
  }
}

/** Request stream messages; each message is limited to maxMessageBytes. Garbage → 400/413, never 500. */
async function* readInputStream(req: Exchange, maxMessageBytes: number, blobs: boolean, maxDepth: number): AsyncGenerator<unknown> {
  // Blobs of one message share the body budget; a single call only uses lane 0.
  const assembler = blobs ? new BlobAssembler(maxMessageBytes) : undefined;
  try {
    for await (const frame of decodeFrames(req as AsyncIterable<Uint8Array>, maxMessageBytes)) {
      if (frame.lane !== 0) throw new ApueError(400, 'Malformed Stream', `lane ${frame.lane} in a request stream`, { type: ProblemType.MALFORMED_STREAM });
      if (frame.type === FrameType.BLOB) {
        if (!assembler) throw new ApueError(400, 'Malformed Stream', 'BLOB frame for an op without bytes', { type: ProblemType.MALFORMED_STREAM });
        assembler.push(frame);
      } else if (frame.type === FrameType.MSG) {
        const value = parseJson(frame.payload, 'request stream message', maxDepth);
        yield assembler ? assembler.resolve(value) : value;
      } else if (frame.type === FrameType.END) {
        const info = parseJson(frame.payload, 'END frame', maxDepth) as EndInfo;
        if (typeof info?.status !== 'number') throw new ApueError(400, 'Malformed Stream', 'END frame without status', { type: ProblemType.MALFORMED_STREAM });
        if (info.status >= 400) throw ApueError.fromProblem(info.problem, info.status);
        return;
      }
    }
  } catch (error) {
    if (error instanceof FrameError) {
      if (error.code === 'too-large') throw new ApueError(413, 'Content Too Large', error.message);
      throw new ApueError(400, 'Malformed Stream', error.message, { type: ProblemType.MALFORMED_STREAM });
    }
    // A reset or prematurely closed request stream means the client went away (was passed through
    // raw and logged as a handler failure); anything else is a server bug and stays one.
    if (isClientGone(error)) throw new ApueError(499, 'Client Closed Request', `request stream ended abnormally: ${(error as Error).message}`);
    throw error;
  }
  throw new ApueError(400, 'Truncated Stream', 'request body ended without END frame', { type: ProblemType.TRUNCATED_STREAM });
}

function parseJson(payload: Uint8Array, what: string, maxDepth: number): unknown {
  checkJsonDepth(payload, maxDepth);
  try {
    return decodeJson(payload);
  } catch {
    throw new ApueError(400, 'Malformed Stream', `${what} is not valid JSON`, { type: ProblemType.MALFORMED_STREAM });
  }
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

/** Cache-Control plus the RFC 9213 / RFC 9875 CDN headers of a safe op's policy. */
function cacheHeaders(def: OpDef): Record<string, string> {
  const headers: Record<string, string> = { 'cache-control': cacheControl(def) };
  if (def.cache?.cdnMaxAge !== undefined) headers['cdn-cache-control'] = `max-age=${def.cache.cdnMaxAge}`;
  if (def.cache?.groups?.length) headers['cache-groups'] = sfStringList(def.cache.groups);
  return headers;
}

/** RFC 9651 List of Strings (group names are validated as printable ASCII in op()). */
function sfStringList(values: readonly string[]): string {
  return values.map((value) => `"${value.replace(/[\\"]/g, '\\$&')}"`).join(', ');
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

// PATCH/DELETE and the Upload-* fields are for resumable uploads (`/$uploads`).
const CORS_ALLOW_METHODS = 'DELETE, GET, HEAD, PATCH, POST, QUERY';
const CORS_ALLOW_HEADERS = new Set(['accept', 'authorization', 'dpop', 'content-type', 'idempotency-key', 'if-none-match', 'incremental', Header.TIMEOUT, Header.RESUME, 'last-event-id', 'upload-complete', 'upload-offset', 'upload-length', 'upload-draft-interop-version', 'range', 'if-range', Header.REPLICA]);
const CORS_EXPOSE_HEADERS = 'etag, apue-replayed, deprecation, sunset, link, retry-after, accept-query, content-encoding, location, upload-offset, upload-complete, upload-limit, upload-length, www-authenticate, dpop-nonce, accept-ranges, content-range, content-disposition, repr-digest';

/**
 * Adds CORS response headers for an allowed Origin and answers preflights. Returns true when the
 * request was a preflight (already answered). Disallowed origins get no CORS headers, so the
 * browser blocks them; their preflights get 403.
 */
function applyCors(req: Exchange, res: Exchange, cors: CorsOptions): boolean {
  const origin = req.headers.origin;
  const allowed = typeof origin === 'string' && (cors.origins === '*' || cors.origins.includes(origin));
  const preflight = req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined;
  // With an origin list the response depends on Origin for *every* request — including ones
  // without or with a foreign Origin — or a shared cache could serve one origin's answer to another.
  if (cors.origins !== '*') res.setHeader('vary', 'origin');
  if (allowed) {
    res.setHeader('access-control-allow-origin', cors.origins === '*' ? '*' : origin);
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

/**
 * Waits for an idempotency store to record a result (before the response goes out, so a fast retry
 * sees it). A failure to store doesn't change the response — the operation already ran — it is
 * logged: a retry with that key may run the operation again.
 */
function settleKey(result: void | Promise<void>): Promise<void> | void {
  if (result instanceof Promise) return result.catch((error) => console.error('apü: the idempotency store failed to record a result', error));
}

/** True if `promise` settles within `ms` (Infinity: waits); the timer never keeps the process alive. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  if (ms === Infinity) return promise.then(() => true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([promise.then(() => true as const), expired]);
  } finally {
    clearTimeout(timer);
  }
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
  // A handler awaiting something with ctx.signal (timers/promises, events.once, pipeline) rejects
  // with Node's AbortError when the client goes: a disconnect, not a server failure — not logged.
  if (isClientGone(error)) return { title: 'Client Closed Request', status: 499 };
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

/** Upper bound for apue-timeout: what timers accept (2³¹−1 ms ≈ 24.8 days). */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function parseTimeout(value: string | string[] | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms <= 0 || ms > MAX_TIMEOUT_MS) throw new ApueError(400, 'Bad Request', `invalid ${Header.TIMEOUT}`);
  return ms;
}

/**
 * Rejects JSON nested deeper than maxDepth with one linear scan (strings skipped) before parsing.
 * Text shorter than 2 × maxDepth cannot exceed it, so small payloads skip the scan.
 */
function checkJsonDepth(text: Uint8Array | string, maxDepth: number): void {
  if (text.length <= maxDepth * 2) return;
  const bytes = typeof text === 'string';
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = bytes ? (text as string).charCodeAt(i) : (text as Uint8Array)[i]!;
    if (inString) {
      if (c === 0x5c) i++; // backslash: skip the escaped character
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x5b || c === 0x7b) {
      if (++depth > maxDepth) throw new ApueError(400, 'Bad Request', `JSON nested deeper than ${maxDepth} levels`);
    } else if (c === 0x5d || c === 0x7d) {
      depth--;
    }
  }
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new ApueError(400, 'Bad Request', 'malformed percent-encoding in the path');
  }
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
