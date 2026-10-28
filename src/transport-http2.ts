// node:http2 transport: tier T1 (true full duplex), one multiplexed session per origin.
import http2 from 'node:http2';
import type { Transport, TransportResponse } from './client.ts';
import { createDecompressor } from './compression.ts';
import { pump } from './node-streams.ts';

export interface Http2TransportOptions {
  /** Extra CA certificate(s), e.g. a self-signed dev cert. */
  ca?: string | Buffer;
  streamWindow?: number;
  connectionWindow?: number;
  /** Sent as Accept-Encoding; responses are decompressed transparently. Empty string disables. */
  acceptEncoding?: string;
}

export function http2Transport(origin: string, options: Http2TransportOptions = {}): Transport {
  const { ca, streamWindow = 4 * 1024 * 1024, connectionWindow = 32 * 1024 * 1024, acceptEncoding = 'zstd, br, gzip' } = options;
  let session: http2.ClientHttp2Session | undefined;

  function getSession(): http2.ClientHttp2Session {
    if (session && !session.closed && !session.destroyed) return session;
    const created = http2.connect(origin, {
      ...(ca === undefined ? {} : { ca }),
      settings: { initialWindowSize: streamWindow },
    });
    created.on('connect', () => created.setLocalWindowSize(connectionWindow));
    created.on('error', () => {}); // surfaced per request via stream errors
    created.on('close', () => {
      if (session === created) session = undefined;
    });
    session = created;
    return created;
  }

  return {
    request({ method, path, headers, body, signal }) {
      const requestHeaders = acceptEncoding && !('accept-encoding' in headers) ? { 'accept-encoding': acceptEncoding, ...headers } : headers;
      const stream = getSession().request(
        { ':method': method, ':path': path, ...requestHeaders },
        { endStream: body === undefined, signal },
      );
      if (body instanceof Uint8Array) stream.end(body);
      else if (body !== undefined) void pump(body, stream);

      return new Promise<TransportResponse>((resolve, reject) => {
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onClose = () => {
          cleanup();
          reject(new Error(`stream closed before response (rst code ${stream.rstCode})`));
        };
        const cleanup = () => {
          stream.off('error', onError);
          stream.off('close', onClose);
        };
        stream.on('error', onError);
        stream.on('close', onClose);
        stream.once('response', (responseHeaders) => {
          cleanup();
          stream.on('error', () => {}); // later errors end the body iteration
          const coding = String(responseHeaders['content-encoding'] ?? '').trim().toLowerCase();
          let body: AsyncIterable<Uint8Array> = stream;
          if (coding && coding !== 'identity') {
            const decompressor = createDecompressor(coding);
            if (!decompressor) return reject(new Error(`unsupported content-encoding: ${coding}`));
            // Errors and resets propagate both ways; destroying the body (consumer stops) resets the stream.
            stream.on('error', (error) => decompressor.destroy(error));
            stream.on('close', () => {
              if (!stream.readableEnded) decompressor.destroy(new Error(`stream reset (rst code ${stream.rstCode})`));
            });
            decompressor.on('close', () => {
              if (!stream.destroyed && !stream.readableEnded) stream.destroy();
            });
            stream.pipe(decompressor);
            body = decompressor;
          }
          const source = body;
          resolve({
            // Event-based collection skips creating a Readable async iterator per response.
            bytes: () =>
              new Promise<Uint8Array>((done, fail) => {
                const readable = source as NodeJS.ReadableStream & import('node:stream').Readable;
                const chunks: Buffer[] = [];
                readable.on('data', (chunk: Buffer) => chunks.push(chunk));
                readable.once('end', () => done(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)));
                readable.once('error', fail);
                readable.once('close', () => {
                  if (!readable.readableEnded) fail(new Error(`stream closed before the response ended (rst code ${stream.rstCode})`));
                });
              }),
            status: Number(responseHeaders[':status']),
            headers: {
              get(name) {
                const value = responseHeaders[name.toLowerCase()];
                return value === undefined ? null : String(value);
              },
            },
            body,
          });
        });
      });
    },
    close() {
      const current = session;
      session = undefined;
      if (!current || current.closed) return Promise.resolve();
      return new Promise((resolve) => current.close(() => resolve()));
    },
  };
}
