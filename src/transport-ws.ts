// Tier T3 client transport: one WebSocket per call carrying the apü frame stream in both
// directions — full duplex in every browser (fetch request streaming is Chromium-only). Web-only.
import { fetchTransport, type Transport, type TransportResponse } from './client.ts';
import { Header, MediaType } from './protocol.ts';

export const WS_SUBPROTOCOL = 'apue.v0';
/** Client close code for "call cancelled" (4000–4999 is the private-use range). */
export const WS_CLOSE_CANCELLED = 4000;
export const MAX_BUFFERED = 1024 * 1024;
const MAX_POLL_MS = 64;

export function webSocketTransport(baseUrl: string, WebSocketImpl: typeof WebSocket = WebSocket): Transport {
  const base = baseUrl.replace(/\/$/, '').replace(/^http/, 'ws');
  return {
    async request({ path, headers, body, signal }) {
      // Browsers can't set WebSocket headers: the deadline travels as a query parameter.
      const timeout = headers[Header.TIMEOUT];
      const url = `${base}${path}${timeout ? `${path.includes('?') ? '&' : '?'}timeout=${encodeURIComponent(timeout)}` : ''}`;
      const ws = new WebSocketImpl(url, WS_SUBPROTOCOL);
      ws.binaryType = 'arraybuffer';

      const queue: Uint8Array[] = [];
      let ended = false;
      let failure: Error | undefined;
      let wake: (() => void) | undefined;
      const notify = () => {
        const w = wake;
        wake = undefined;
        w?.();
      };
      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) queue.push(new Uint8Array(event.data));
        notify();
      };
      ws.onclose = (event) => {
        ended = true;
        // An abnormal close without END frame surfaces as a truncated stream in the client.
        if (event.code !== 1000 && event.code !== WS_CLOSE_CANCELLED) failure = new Error(`WebSocket closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`);
        notify();
      };
      const onAbort = () => ws.close(WS_CLOSE_CANCELLED, 'cancelled');
      signal.addEventListener('abort', onAbort, { once: true });

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error(`WebSocket connection to ${url} failed`));
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      if (ws.protocol !== WS_SUBPROTOCOL) {
        ws.close(1002);
        throw new Error(`server did not accept subprotocol ${WS_SUBPROTOCOL}`);
      }

      if (body instanceof Uint8Array) ws.send(body as Uint8Array<ArrayBuffer>);
      else if (body !== undefined) void pump(ws, body);

      async function* responseBody(): AsyncGenerator<Uint8Array> {
        try {
          for (;;) {
            if (queue.length > 0) {
              yield queue.shift()!;
              continue;
            }
            if (ended) {
              if (failure) throw failure;
              return;
            }
            await new Promise<void>((resolve) => (wake = resolve));
          }
        } finally {
          signal.removeEventListener('abort', onAbort);
          if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(WS_CLOSE_CANCELLED, 'cancelled');
        }
      }
      const response: TransportResponse = {
        status: 200,
        headers: new Headers({ 'content-type': MediaType.STREAM_JSON }),
        body: responseBody(),
      };
      return response;
    },
  };
}

/**
 * WebSocket has no 'drain' event: poll bufferedAmount to keep uploads from piling up in memory.
 * The poll interval adapts: a fixed 5 ms capped uploads at MAX_BUFFERED / 5 ms (measured 140 MiB/s
 * on loopback, the socket idle a quarter of the time); it halves when the buffer ran empty while
 * waiting (the socket idled) and doubles while the buffer is still full (slow link, save CPU).
 */
export async function pump(ws: Pick<WebSocket, 'send' | 'close' | 'bufferedAmount' | 'readyState' | 'OPEN'>, body: AsyncIterable<Uint8Array>): Promise<void> {
  let waitMs = 4;
  try {
    for await (const chunk of body) {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(chunk as Uint8Array<ArrayBuffer>);
      while (ws.bufferedAmount > MAX_BUFFERED && ws.readyState === ws.OPEN) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        const left = ws.bufferedAmount;
        if (left === 0) waitMs = Math.max(1, waitMs / 2);
        else if (left > MAX_BUFFERED) waitMs = Math.min(MAX_POLL_MS, waitMs * 2);
      }
    }
  } catch {
    ws.close(WS_CLOSE_CANCELLED, 'input failed');
  }
}

/**
 * Browser default: fetch for everything (HTTP caching, h2 multiplexing), except calls with a
 * request stream when this browser can't stream fetch request bodies — those use a WebSocket.
 */
export function autoTransport(baseUrl: string): Transport {
  const http = fetchTransport(baseUrl);
  const ws = webSocketTransport(baseUrl);
  const streamingFetch = supportsRequestStreams();
  return {
    request(req) {
      const requestStream = req.body !== undefined && !(req.body instanceof Uint8Array);
      return requestStream && !streamingFetch ? ws.request(req) : http.request(req);
    },
  };
}

/** Feature detection from https://developer.chrome.com/docs/capabilities/web-apis/fetch-streaming-requests */
export function supportsRequestStreams(): boolean {
  let duplexAccessed = false;
  try {
    const hasContentType = new Request('https://example.invalid', {
      body: new ReadableStream(),
      method: 'POST',
      get duplex() {
        duplexAccessed = true;
        return 'half';
      },
    } as RequestInit).headers.has('Content-Type');
    return duplexAccessed && !hasContentType;
  } catch {
    return false;
  }
}
