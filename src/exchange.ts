// One request/response exchange, independent of the HTTP version. HTTP/2 uses node:http2's core
// stream API directly (~23% faster than the compat layer, bench S4); HTTP/1.1 uses node:http.
import http2 from 'node:http2';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex, Writable } from 'node:stream';
import { decodeJson, endFrame, msgFrame } from './frame.ts';
import { Header, MediaType } from './protocol.ts';
import type { WsConnection } from './websocket.ts';

export interface Exchange extends AsyncIterable<Uint8Array> {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly httpVersion: string;
  readonly headersSent: boolean;
  /** The response body as a Writable (for FrameWriter, backpressure and 'drain'). */
  readonly sink: Writable;
  /** Adds a header to the response that will be sent next. */
  setHeader(name: string, value: string): void;
  /** Sends status and headers now; the body follows via `sink`/`end` (streaming). */
  writeHead(status: number, headers: Record<string, string>): void;
  /** Sends a complete response; `body` undefined means no content (HEAD, 304). */
  send(status: number, headers: Record<string, string>, body?: Uint8Array): void;
  end(): void;
  /** Called once when the exchange is over (completed, reset or connection lost). */
  onClose(callback: () => void): void;
  /** Sends an interim (1xx) response, where the protocol allows it (HTTP/2; Node's HTTP/1.1 API cannot). */
  interim?(status: number, headers: Record<string, string>): void;
}

export class H2Exchange implements Exchange {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly httpVersion = '2.0';
  headersSent = false;
  #stream: http2.ServerHttp2Stream;
  #extra: Record<string, string> = {};

  constructor(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) {
    this.#stream = stream;
    // A peer resetting the stream with an error code other than CANCEL (e.g. Envoy's
    // INTERNAL_ERROR) makes node:http2 emit 'error'; unhandled, that crashes the process.
    // The 'close' event already turns it into an aborted call.
    stream.on('error', () => {});
    this.headers = headers;
    this.method = headers[':method'] ?? 'GET';
    this.url = headers[':path'] ?? '/';
  }

  get sink(): Writable {
    return this.#stream;
  }

  // destroyOnReturn: false — a consumer that stops reading early (e.g. after the END frame) must
  // not reset the stream; the unread rest is discarded once the response is complete.
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return this.#stream.iterator({ destroyOnReturn: false });
  }

  setHeader(name: string, value: string): void {
    this.#extra[name] = value;
  }

  writeHead(status: number, headers: Record<string, string>): void {
    if (this.#gone()) return;
    this.#stream.respond({ ...mergeHeaders(this.#extra, headers), ':status': status });
    this.headersSent = true;
  }

  interim(status: number, headers: Record<string, string>): void {
    if (!this.headersSent && !this.#gone()) this.#stream.additionalHeaders({ ...headers, ':status': status });
  }

  send(status: number, headers: Record<string, string>, body?: Uint8Array): void {
    if (this.#gone()) return;
    const all = { ...mergeHeaders(this.#extra, headers), ':status': status };
    // respond() without an options object is measurably faster (bench S6); options only for
    // bodiless responses (HEAD, 304, 204).
    if (body === undefined || body.byteLength === 0) {
      this.#stream.respond(all, { endStream: true });
    } else {
      this.#stream.respond(all);
      this.#stream.end(body);
    }
    this.headersSent = true;
    this.#discardRequest();
  }

  end(): void {
    if (this.#gone()) return;
    this.#stream.end();
    this.#discardRequest();
  }

  // Only after the response is fully written: resuming earlier ends the readable side at once and
  // node:http2 then destroys the stream with the body write still pending (an ERR_STREAM_DESTROYED
  // is created per request — 2.4% of server CPU in bench S6).
  #discardRequest(): void {
    const stream = this.#stream;
    if (stream.readableEnded) return;
    if (stream.writableFinished) stream.resume();
    else stream.once('finish', () => stream.resume());
  }

  onClose(callback: () => void): void {
    this.#stream.once('close', callback);
  }

  #gone(): boolean {
    return this.#stream.destroyed || this.#stream.closed;
  }
}

export class H1Exchange implements Exchange {
  readonly #req: IncomingMessage;
  readonly #res: ServerResponse;

  constructor(req: IncomingMessage, res: ServerResponse) {
    this.#req = req;
    this.#res = res;
    // Connection resets surface as 'close'; don't let 'error' crash the process.
    req.on('error', () => {});
    res.on('error', () => {});
  }

  get method(): string {
    return this.#req.method ?? 'GET';
  }
  get url(): string {
    return this.#req.url ?? '/';
  }
  get headers(): IncomingHttpHeaders {
    return this.#req.headers;
  }
  get httpVersion(): string {
    return this.#req.httpVersion;
  }
  get headersSent(): boolean {
    return this.#res.headersSent;
  }
  get sink(): Writable {
    return this.#res;
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return this.#req.iterator({ destroyOnReturn: false });
  }

  setHeader(name: string, value: string): void {
    this.#res.setHeader(name, value);
  }

  writeHead(status: number, headers: Record<string, string>): void {
    this.#res.writeHead(status, this.#merged(headers));
    this.#res.flushHeaders();
  }

  send(status: number, headers: Record<string, string>, body?: Uint8Array): void {
    this.#res.writeHead(status, this.#merged(headers));
    if (body && body.byteLength > 0) this.#res.end(body);
    else this.#res.end();
    if (!this.#req.readableEnded) this.#req.resume();
  }

  end(): void {
    this.#res.end();
    if (!this.#req.readableEnded) this.#req.resume();
  }

  onClose(callback: () => void): void {
    this.#res.once('close', callback);
  }

  /** writeHead replaces same-named headers from setHeader; Vary must be combined instead. */
  #merged(headers: Record<string, string>): Record<string, string> {
    const vary = this.#res.getHeader('vary');
    return vary !== undefined && headers.vary !== undefined ? { ...headers, vary: `${String(vary)}, ${headers.vary}` } : headers;
  }
}

/** Response headers set earlier plus those of this response; Vary values are combined. */
function mergeHeaders(extra: Record<string, string>, headers: Record<string, string>): Record<string, string> {
  const merged = { ...extra, ...headers };
  if (extra.vary !== undefined && headers.vary !== undefined) merged.vary = `${extra.vary}, ${headers.vary}`;
  return merged;
}

/**
 * A WebSocket call (tier T3) seen as an Exchange: the handshake already happened, the request body
 * is the incoming byte stream and the response body the outgoing one. A complete response
 * (`send`) has no WebSocket equivalent and is delivered in-band as MSG/END frames.
 */
export class WsExchange implements Exchange {
  readonly method = 'POST';
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly httpVersion: string;
  headersSent = false;
  #conn: WsConnection;

  constructor(conn: WsConnection, path: string, headers: IncomingHttpHeaders, httpVersion: string) {
    this.#conn = conn;
    this.url = path;
    this.httpVersion = httpVersion;
    // Browsers can't set headers on a WebSocket: metadata comes from the URL instead.
    const timeout = new URLSearchParams(path.split('?')[1] ?? '').get('timeout');
    const { 'accept-encoding': _, ...rest } = headers;
    this.headers = { ...rest, 'content-type': MediaType.STREAM_JSON, accept: MediaType.STREAM_JSON, ...(timeout ? { [Header.TIMEOUT]: timeout } : {}) };
  }

  get sink(): Writable {
    return this.#conn.sink;
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return this.#conn[Symbol.asyncIterator]();
  }

  setHeader(): void {}

  writeHead(): void {
    this.headersSent = true;
  }

  send(status: number, _headers: Record<string, string>, body?: Uint8Array): void {
    this.headersSent = true;
    const payload = body && body.byteLength > 0 ? decodeJson(body) : undefined;
    if (status >= 400) {
      this.#conn.sink.write(endFrame({ status, problem: (payload as never) ?? { title: 'Error', status } }));
    } else {
      if (payload !== undefined) this.#conn.sink.write(msgFrame(payload));
      this.#conn.sink.write(endFrame({ status }));
    }
    this.#conn.sink.end();
  }

  end(): void {
    this.#conn.sink.end();
  }

  onClose(callback: () => void): void {
    this.#conn.onClose(callback);
  }
}

export type WebSocketUpgrade =
  | { kind: 'h2'; stream: http2.ServerHttp2Stream; headers: http2.IncomingHttpHeaders }
  | { kind: 'h1'; req: IncomingMessage; socket: Socket; head: Buffer };

/**
 * Routes HTTP/2 streams to the core API and HTTP/1.1 requests (allowHTTP1) to node:http.
 * Registering a 'request' listener makes node:http2 install its compat 'stream' listener; that
 * one is removed again so HTTP/2 never pays for the compat layer. WebSocket handshakes (HTTP/2
 * extended CONNECT, HTTP/1.1 Upgrade) go to `onWebSocket`.
 */
export function onExchange(
  server: http2.Http2SecureServer,
  handler: (exchange: Exchange) => void,
  onWebSocket?: (upgrade: WebSocketUpgrade) => void,
): void {
  const onStream = (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    if (headers[':method'] === 'CONNECT') {
      if (headers[':protocol'] === 'websocket' && onWebSocket) return onWebSocket({ kind: 'h2', stream, headers });
      stream.respond({ ':status': 405, allow: 'GET, HEAD, POST, QUERY' });
      return void stream.end();
    }
    handler(new H2Exchange(stream, headers));
  };
  server.on('stream', onStream);
  server.on('request', (req: unknown, res: unknown) => handler(new H1Exchange(req as IncomingMessage, res as ServerResponse)));
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (onWebSocket && String(req.headers.upgrade).toLowerCase() === 'websocket') onWebSocket({ kind: 'h1', req, socket: socket as Socket, head });
    else socket.destroy();
  });
  for (const listener of server.listeners('stream') as unknown[]) {
    if (listener !== onStream) server.removeListener('stream', listener as (...args: unknown[]) => void);
  }
  if (server.listeners('stream').length !== 1) throw new Error('could not detach the http2 compat layer');
}
