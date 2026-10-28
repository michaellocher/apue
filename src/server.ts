// apü server spike (S1): POST /{op}, unary JSON or framed streaming in both directions.
import http2 from 'node:http2';
import type { Writable } from 'node:stream';
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
import { drained } from './node-streams.ts';
import { ApueError, baseMediaType, Header, isAsyncIterable, MediaType } from './protocol.ts';

export interface CallContext {
  readonly op: string;
  /** Aborted when the client goes away or the deadline (`apue-timeout`) passes. */
  readonly signal: AbortSignal;
  readonly headers: http2.IncomingHttpHeaders;
  readonly httpVersion: string;
}

/**
 * Returns a value (unary response) or an AsyncIterable (framed stream response).
 * `input` is the decoded JSON body, or an AsyncIterable of messages for streaming requests.
 */
export type Handler = (input: any, ctx: CallContext) => unknown;

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
}

export interface ApueServer {
  readonly server: http2.Http2SecureServer;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

const STREAM_HEADERS = {
  'content-type': MediaType.STREAM_JSON,
  'cache-control': 'no-store',
  // RFC 10036: ask intermediaries not to buffer; nginx honours X-Accel-Buffering.
  incremental: '?1',
  'x-accel-buffering': 'no',
};

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

export function createApueServer(handlers: Record<string, Handler>, options: ApueServerOptions): ApueServer {
  const {
    heartbeatMs = 15_000,
    commitAfterMs = 50,
    coalesceBytes = 16 * 1024,
    maxBodyBytes = 1024 * 1024,
    streamWindow = 4 * 1024 * 1024,
    connectionWindow = 32 * 1024 * 1024,
  } = options;

  const serverOptions: http2.SecureServerOptions & { connectionWindowSize?: number } = {
    key: options.key,
    cert: options.cert,
    allowHTTP1: true,
    settings: { initialWindowSize: streamWindow },
    connectionWindowSize: connectionWindow, // Node ≥ 26.11
  };
  const server = http2.createSecureServer(serverOptions);
  // Nagle + delayed ACK can stall small frames by 40–200 ms (research/02 §6).
  const sockets = new Set<import('node:net').Socket>();
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on('connection', (socket: import('node:net').Socket) => {
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
    try {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        throw new ApueError(405, 'Method Not Allowed', `${req.method} is not supported yet (S1 is POST-only)`);
      }
      const path = req.url.split('?', 1)[0]!;
      const op = decodeURIComponent(path.slice(1));
      const handler = Object.hasOwn(handlers, op) ? handlers[op] : undefined;
      if (!handler) throw new ApueError(404, 'Unknown Operation', op);

      const timeoutMs = parseTimeout(req.headers[Header.TIMEOUT]);
      if (timeoutMs !== undefined) signal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);

      const ctx: CallContext = { op, signal, headers: req.headers, httpVersion: req.httpVersion };
      const input = await readInput(req, maxBodyBytes);
      const result = await abortable(Promise.resolve(handler(input, ctx)), signal);
      if (isAsyncIterable(result)) {
        await streamResponse(req, res, result, signal, clientGone.signal, complete);
      } else {
        complete();
        sendJson(res, 200, MediaType.JSON, result ?? null);
      }
    } catch (error) {
      if (clientGone.signal.aborted) return;
      const problem = toProblem(error);
      complete();
      if (res.headersSent) res.end();
      else sendJson(res, problem.status, MediaType.PROBLEM, problem);
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
    res.writeHead(200, { ...STREAM_HEADERS, 'content-type': renderer.contentType });
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
          resolve((server.address() as import('node:net').AddressInfo).port);
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

function isClosed(sink: Writable): boolean {
  return sink.destroyed === true || sink.writableEnded;
}

async function readInput(req: http2.Http2ServerRequest, maxBodyBytes: number): Promise<unknown> {
  const type = baseMediaType(req.headers['content-type']);
  if (type === MediaType.STREAM_JSON) return readInputStream(req);
  if (type !== MediaType.JSON && type !== '') {
    throw new ApueError(415, 'Unsupported Media Type', type);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > maxBodyBytes) throw new ApueError(413, 'Content Too Large', `limit is ${maxBodyBytes} bytes`);
    chunks.push(chunk);
  }
  return size === 0 ? undefined : decodeJson(concatBytes(chunks, size));
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
  throw new ApueError(400, 'Truncated Input Stream', 'request body ended without END frame');
}

function sendJson(res: http2.Http2ServerResponse, status: number, contentType: string, body: unknown): void {
  const bytes = encodeJson(body);
  res.writeHead(status, { 'content-type': contentType, 'content-length': bytes.byteLength });
  res.end(bytes);
}

function toProblem(error: unknown): Problem {
  if (error instanceof ApueError) return error.problem;
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return { title: 'Deadline Exceeded', status: 504, retryable: true };
  }
  if (error instanceof SyntaxError) return { title: 'Bad Request', status: 400, detail: 'malformed JSON' };
  console.error('apü handler error:', error);
  return { title: 'Internal Server Error', status: 500 };
}

function parseTimeout(value: string | string[] | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms <= 0) throw new ApueError(400, 'Bad Request', `invalid ${Header.TIMEOUT}`);
  return ms;
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
