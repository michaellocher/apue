// Tier T3 client transport: one WebSocket per call carrying the apü frame stream in both
// directions — full duplex in every browser (fetch request streaming is Chromium-only). Web-only.
// Flow control as in src/websocket.ts: binary bytes use up a window, text messages ("65536")
// extend it; the browser API can't pause receiving, so the window is what bounds client memory.
import { fetchTransport, type Transport, type TransportResponse } from './client.ts';
import { Header, MediaType } from './protocol.ts';

export const WS_SUBPROTOCOL = 'apue.v1';
/** Client close code for "call cancelled" (4000–4999 is the private-use range). */
export const WS_CLOSE_CANCELLED = 4000;
const INITIAL_WINDOW = 64 * 1024; // = WS_INITIAL_WINDOW in websocket.ts (Node-only module)
const MAX_WINDOW = 2 ** 31 - 1;

export interface WebSocketTransportOptions {
  /** Bytes the server may send ahead of the consumer: the client-side memory bound per call. */
  receiveWindow?: number;
  WebSocketImpl?: typeof WebSocket;
}

/** Parses a credit text message (same rules as the server's parseCredit). */
function parseCredit(text: string): number | undefined {
  if (!/^[1-9]\d{0,9}$/.test(text)) return undefined;
  const n = Number(text);
  return n <= MAX_WINDOW ? n : undefined;
}

export function webSocketTransport(baseUrl: string, options: WebSocketTransportOptions = {}): Transport {
  const base = baseUrl.replace(/\/$/, '').replace(/^http/, 'ws');
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  const receiveWindow = Math.min(Math.max(options.receiveWindow ?? 4 * 1024 * 1024, INITIAL_WINDOW), MAX_WINDOW);
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
      let sendCredit = INITIAL_WINDOW; // bytes we may still send
      let receiveAllowance = INITIAL_WINDOW; // bytes the server may still send
      let consumed = 0; // bytes handed to the consumer since the last credit
      let creditWake: (() => void) | undefined;
      const wakeSender = () => {
        const w = creditWake;
        creditWake = undefined;
        w?.();
      };
      const violation = (reason: string, code: number) => {
        failure ??= new Error(`WebSocket flow control: ${reason}`);
        ws.close(code === 1002 ? 4002 : 4008, reason); // browsers may only send 1000 and 3000–4999
      };
      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          const increment = parseCredit(event.data);
          if (increment === undefined) return violation('invalid credit', 1002);
          if (sendCredit + increment > MAX_WINDOW) return violation('credit beyond 2^31-1', 1002);
          sendCredit += increment;
          return wakeSender();
        }
        if (!(event.data instanceof ArrayBuffer)) return;
        receiveAllowance -= event.data.byteLength;
        if (receiveAllowance < 0) return violation('server exceeded the window', 1008);
        queue.push(new Uint8Array(event.data));
        notify();
      };
      ws.onclose = (event) => {
        ended = true;
        // An abnormal close without END frame surfaces as a truncated stream in the client.
        if (event.code !== 1000 && event.code !== WS_CLOSE_CANCELLED) failure ??= new Error(`WebSocket closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`);
        notify();
        wakeSender();
      };

      /** Sends bytes as binary messages, each within the credit; resolves false if the socket closed. */
      async function send(bytes: Uint8Array): Promise<boolean> {
        for (let offset = 0; offset < bytes.byteLength; ) {
          if (ws.readyState !== ws.OPEN) return false;
          if (sendCredit <= 0) {
            await new Promise<void>((resolve) => (creditWake = resolve));
            continue;
          }
          const n = Math.min(sendCredit, bytes.byteLength - offset);
          ws.send(bytes.subarray(offset, offset + n) as Uint8Array<ArrayBuffer>);
          sendCredit -= n;
          offset += n;
        }
        return true;
      }
      async function pump(body: AsyncIterable<Uint8Array>): Promise<void> {
        try {
          for await (const chunk of body) if (!(await send(chunk))) return;
        } catch {
          ws.close(WS_CLOSE_CANCELLED, 'input failed');
        }
      }
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

      if (receiveWindow > INITIAL_WINDOW) {
        ws.send(String(receiveWindow - INITIAL_WINDOW));
        receiveAllowance += receiveWindow - INITIAL_WINDOW;
      }
      if (body instanceof Uint8Array) void send(body);
      else if (body !== undefined) void pump(body);

      async function* responseBody(): AsyncGenerator<Uint8Array> {
        try {
          for (;;) {
            if (queue.length > 0) {
              const chunk = queue.shift()!;
              consumed += chunk.byteLength;
              if (consumed >= receiveWindow / 2 && ws.readyState === ws.OPEN) {
                ws.send(String(consumed));
                receiveAllowance += consumed;
                consumed = 0;
              }
              yield chunk;
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
