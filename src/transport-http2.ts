// node:http2 transport: tier T1 (true full duplex), one multiplexed session per origin.
import http2 from 'node:http2';
import type { Transport, TransportResponse } from './client.ts';
import { createDecompressor } from './compression.ts';
import { pump } from './node-streams.ts';

export interface Http2TransportOptions {
  /** Extra CA certificate(s), e.g. a self-signed dev cert. */
  ca?: string | Buffer;
  /**
   * 'fixed' (default): streamWindow as is. 'bdp' (opt-in, experimental): start at 256 KiB and grow
   * from PING-measured bandwidth-delay samples (gRPC's estimator). Measured in
   * docs/benchmarks.md: not better than a fixed 4 MiB window in our scenarios, so not the default.
   */
  windowTuning?: 'bdp' | 'fixed';
  /** Fixed mode: the stream window (default 4 MiB). BDP mode: the upper bound (default 16 MiB). */
  streamWindow?: number;
  connectionWindow?: number;
  /** Sent as Accept-Encoding; responses are decompressed transparently. Empty string disables. */
  acceptEncoding?: string;
}

export interface Http2Transport extends Transport {
  /** Current per-stream receive window of the live session (for tests and diagnostics). */
  readonly streamWindow: number;
}

const BDP_INITIAL_WINDOW = 256 * 1024;
const BDP_MAX_WINDOW = 16 * 1024 * 1024;
const BDP_PROBE_INTERVAL_MS = 25;

export function http2Transport(origin: string, options: Http2TransportOptions = {}): Http2Transport {
  const { ca, windowTuning = 'fixed', connectionWindow = 32 * 1024 * 1024, acceptEncoding = 'zstd, br, gzip' } = options;
  const bdp = windowTuning === 'bdp';
  const maxWindow = options.streamWindow ?? (bdp ? BDP_MAX_WINDOW : 4 * 1024 * 1024);
  let session: http2.ClientHttp2Session | undefined;
  let window = bdp ? Math.min(BDP_INITIAL_WINDOW, maxWindow) : maxWindow;
  let inFlight = 0;
  let probing = false;
  let rtt = 0; // smoothed PING round-trip time (ms)
  let maxBandwidth = 0; // highest bytes/ms seen

  /**
   * gRPC's BDP estimator: one PING round trip measures the bytes that arrive per RTT. Grow the
   * window to twice the sample only if the sample fills > 2/3 of it AND the implied bandwidth is
   * a new maximum. Without the bandwidth check, PINGs queued behind data inflate both sample and
   * RTT under load, and the window grows into the queue (measured: 8–18 ms latency for small
   * calls next to a bulk download, instead of 0.2–2.5 ms).
   */
  function probe(target: http2.ClientHttp2Session): void {
    if (!bdp || probing || inFlight === 0 || target !== session || target.destroyed || target.closed || window >= maxWindow) return;
    probing = true;
    const start = target.socket.bytesRead;
    const sent = target.ping((error, duration) => {
      probing = false;
      if (error || target.destroyed || target.closed) return;
      const sample = target.socket.bytesRead - start;
      rtt = rtt === 0 ? duration : rtt + (duration - rtt) * 0.9;
      const bandwidth = sample / (rtt * 1.5);
      if (sample > (window * 2) / 3 && bandwidth > maxBandwidth) {
        maxBandwidth = bandwidth;
        const next = Math.min(maxWindow, Math.ceil((2 * sample) / 65536) * 65536);
        if (next > window) {
          window = next;
          target.settings({ initialWindowSize: window });
        }
      }
      if (inFlight > 0) setTimeout(() => probe(target), BDP_PROBE_INTERVAL_MS).unref();
    });
    if (!sent) probing = false;
  }

  function getSession(): http2.ClientHttp2Session {
    if (session && !session.closed && !session.destroyed) return session;
    const created = http2.connect(origin, {
      ...(ca === undefined ? {} : { ca }),
      settings: { initialWindowSize: window },
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
    get streamWindow() {
      return window;
    },
    request({ method, path, headers, body, signal }) {
      const requestHeaders = acceptEncoding && !('accept-encoding' in headers) ? { 'accept-encoding': acceptEncoding, ...headers } : headers;
      const stream = getSession().request(
        { ':method': method, ':path': path, ...requestHeaders },
        { endStream: body === undefined, signal },
      );
      if (body instanceof Uint8Array) stream.end(body);
      else if (body !== undefined) void pump(body, stream);
      const owner = getSession();
      inFlight++;
      stream.once('close', () => inFlight--);

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
          probe(owner);
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
                if (readable.readableEnded || readable.destroyed) return fail(new Error('response body was already consumed'));
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
