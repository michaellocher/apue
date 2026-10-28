// node:http2 transport: tier T1 (true full duplex), one multiplexed session per origin.
import http2 from 'node:http2';
import type { Transport, TransportResponse } from './client.ts';
import { pump } from './node-streams.ts';

export interface Http2TransportOptions {
  /** Extra CA certificate(s), e.g. a self-signed dev cert. */
  ca?: string | Buffer;
  streamWindow?: number;
  connectionWindow?: number;
}

export function http2Transport(origin: string, options: Http2TransportOptions = {}): Transport {
  const { ca, streamWindow = 4 * 1024 * 1024, connectionWindow = 32 * 1024 * 1024 } = options;
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
      const stream = getSession().request(
        { ':method': method, ':path': path, ...headers },
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
          resolve({
            status: Number(responseHeaders[':status']),
            headers: {
              get(name) {
                const value = responseHeaders[name.toLowerCase()];
                return value === undefined ? null : String(value);
              },
            },
            body: stream,
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
