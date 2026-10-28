// One request/response exchange, independent of the HTTP version. HTTP/2 uses node:http2's core
// stream API directly (~23% faster than the compat layer, bench S4); HTTP/1.1 uses node:http.
import http2 from 'node:http2';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Writable } from 'node:stream';

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

  send(status: number, headers: Record<string, string>, body?: Uint8Array): void {
    if (this.#gone()) return;
    const empty = body === undefined || body.byteLength === 0;
    this.#stream.respond({ ...mergeHeaders(this.#extra, headers), ':status': status }, { endStream: empty });
    this.headersSent = true;
    if (!empty) this.#stream.end(body);
    this.#discardRequest();
  }

  end(): void {
    if (this.#gone()) return;
    this.#stream.end();
    this.#discardRequest();
  }

  #discardRequest(): void {
    if (!this.#stream.readableEnded) this.#stream.resume();
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
 * Routes HTTP/2 streams to the core API and HTTP/1.1 requests (allowHTTP1) to node:http.
 * Registering a 'request' listener makes node:http2 install its compat 'stream' listener; that
 * one is removed again so HTTP/2 never pays for the compat layer.
 */
export function onExchange(server: http2.Http2SecureServer, handler: (exchange: Exchange) => void): void {
  const onStream = (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => handler(new H2Exchange(stream, headers));
  server.on('stream', onStream);
  server.on('request', (req: unknown, res: unknown) => handler(new H1Exchange(req as IncomingMessage, res as ServerResponse)));
  for (const listener of server.listeners('stream') as unknown[]) {
    if (listener !== onStream) server.removeListener('stream', listener as (...args: unknown[]) => void);
  }
  if (server.listeners('stream').length !== 1) throw new Error('could not detach the http2 compat layer');
}
