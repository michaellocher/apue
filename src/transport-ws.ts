// Tier T3 client transport: one WebSocket per call carrying the apü frame stream in both
// directions — full duplex in every browser (fetch request streaming is Chromium-only). Web-only.
// Flow control as in src/websocket.ts: binary bytes use up a window, text messages ("65536")
// extend it; the browser API can't pause receiving, so the window is what bounds client memory.
import { fetchTransport, type Transport, type TransportResponse } from './client.ts';
import { concatBytes } from './frame.ts';import { checkWindow, Header, MediaType, parseCredit, WS_INITIAL_WINDOW, WS_MAX_WINDOW, WS_SUBPROTOCOL } from './protocol.ts';

/** Client close code for "call cancelled" (4000–4999 is the private-use range). */
export const WS_CLOSE_CANCELLED = 4000;
/** Close codes for protocol errors: browsers may only send 1000 and 3000–4999 (1002/1008 + 3000). */
const WS_CLOSE_PROTOCOL = 4002;
const WS_CLOSE_POLICY = 4008;
/**
 * Unsent bytes in the browser beyond which uploads wait. Credit already bounds them by the
 * server's window (1 MiB default) — this only engages for servers granting huge windows over slow
 * links. WebSocket has no 'drain' event, so it polls, with a backing-off interval.
 */
export const MAX_UNSENT = 4 * 1024 * 1024;
const MAX_POLL_MS = 64;
const COALESCE_BYTES = 16 * 1024;


export interface WebSocketTransportOptions {
  /** Bytes the server may send ahead of the consumer: the client-side memory bound per call. */
  receiveWindow?: number;
  WebSocketImpl?: typeof WebSocket;
  /** Transport for calls without a request stream (default: fetchTransport(baseUrl)). */
  http?: Transport;
}

/**
 * T3 carries calls with a request stream (client/bidi streaming); every other call goes over
 * fetch (T0) — a WebSocket would add a handshake round trip and lose HTTP caching, and it has no
 * headers to carry a unary JSON body or GET input (unary over WebSocket answered 415 before).
 */
export function webSocketTransport(baseUrl: string, options: WebSocketTransportOptions = {}): Transport {
  const base = baseUrl.replace(/\/$/, '').replace(/^http/, 'ws');
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  const receiveWindow = checkWindow('receiveWindow', options.receiveWindow ?? 4 * 1024 * 1024);
  const http = options.http ?? fetchTransport(baseUrl);
  const ownsHttp = options.http === undefined; // a caller's transport may be shared: theirs to close
  const live = new Set<WebSocket>();
  return {
    async close() {
      for (const ws of live) ws.close(WS_CLOSE_CANCELLED, 'transport closed');
      if (ownsHttp) await http.close?.();
    },
    async request(req) {
      if (req.body === undefined || req.body instanceof Uint8Array) return http.request(req);
      const { path, headers, body, signal } = req;
      signal.throwIfAborted(); // an already-aborted signal never fires 'abort'
      // Browsers can't set WebSocket headers: the deadline travels as a query parameter.
      const timeout = headers[Header.TIMEOUT];
      const url = `${base}${path}${timeout ? `${path.includes('?') ? '&' : '?'}timeout=${encodeURIComponent(timeout)}` : ''}`;
      const ws = new WebSocketImpl(url, WS_SUBPROTOCOL);
      ws.binaryType = 'arraybuffer';
      live.add(ws);
      let input: AsyncIterator<Uint8Array> | undefined;

      const queue: Uint8Array[] = [];
      let ended = false;
      let failure: Error | undefined;
      let wake: (() => void) | undefined;
      const notify = () => {
        const w = wake;
        wake = undefined;
        w?.();
      };
      let sendCredit = WS_INITIAL_WINDOW; // bytes we may still send
      let receiveAllowance = WS_INITIAL_WINDOW; // bytes the server may still send
      let consumed = 0; // bytes handed to the consumer since the last credit
      let creditWake: (() => void) | undefined;
      const wakeSender = () => {
        const w = creditWake;
        creditWake = undefined;
        w?.();
      };
      const violation = (reason: string, code: number) => {
        failure ??= new Error(`WebSocket flow control: ${reason}`);
        ws.close(code === 1002 ? WS_CLOSE_PROTOCOL : WS_CLOSE_POLICY, reason);
      };
      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          const increment = parseCredit(event.data);
          if (increment === undefined) return violation('invalid credit', 1002);
          if (sendCredit + increment > WS_MAX_WINDOW) return violation('credit beyond 2^31-1', 1002);
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
        closeChannel(); // also when the producer never yields again
        live.delete(ws);
        void input?.return?.()?.catch?.(() => {}); // release the producer (runs once it next yields or returns)
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
          if (ws.bufferedAmount > MAX_UNSENT) await unsent();
        }
        return true;
      }
      /** Waits until the browser has sent enough; halves the poll after idling, doubles while full. */
      let pollMs = 4;
      async function unsent(): Promise<void> {
        while (ws.bufferedAmount > MAX_UNSENT && ws.readyState === ws.OPEN) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          const left = ws.bufferedAmount;
          if (left === 0) pollMs = Math.max(1, pollMs / 2);
          else if (left > MAX_UNSENT) pollMs = Math.min(MAX_POLL_MS, pollMs * 2);
        }
      }
      // Small frames are coalesced: one ws.send (and WebSocket frame) per message halved small-
      // message throughput against HTTP/2. Pending bytes go out at COALESCE_BYTES, or in the next
      // macrotask (MessageChannel: not clamped like setTimeout), so a lone message waits < 1 ms.
      let pending: Uint8Array[] = [];
      let pendingBytes = 0;
      let queuedBytes = 0; // handed to the send chain, not yet sent (waiting for credit / the network)
      let flushing = Promise.resolve(true);
      let channel: MessageChannel | undefined;
      let flushScheduled = false;
      function flush(): Promise<boolean> {
        flushScheduled = false;
        if (pendingBytes === 0) return flushing;
        const bytes = concatBytes(pending, pendingBytes);
        pending = [];
        pendingBytes = 0;
        queuedBytes += bytes.byteLength;
        return (flushing = flushing
          .then((open) => open && send(bytes))
          .catch((error: unknown) => {
            // e.g. a WebSocket implementation throwing from send(): fail the call, never reject
            failure ??= error as Error;
            if (ws.readyState === ws.OPEN) ws.close(WS_CLOSE_CANCELLED, 'send failed');
            return false;
          })
          .finally(() => (queuedBytes -= bytes.byteLength)));
      }
      const closeChannel = () => {
        channel?.port1.close(); // an open port keeps a Node process alive
        channel = undefined;
      };
      function scheduleFlush(): void {
        if (flushScheduled) return;
        flushScheduled = true;
        if (!channel) {
          channel = new MessageChannel();
          channel.port1.onmessage = () => void flush();
        }
        channel.port2.postMessage(null);
      }
      async function pump(body: AsyncIterable<Uint8Array>): Promise<void> {
        try {
          input = body[Symbol.asyncIterator]();
          for (;;) {
            if (ws.readyState !== ws.OPEN) return void input.return?.(); // the call ended: don't pull (and lose) another chunk
            const next = await input.next();
            if (next.done) break;
            const chunk = next.value;
            if (ws.readyState !== ws.OPEN) return void input.return?.();
            pending.push(chunk);
            pendingBytes += chunk.byteLength;
            // Bounded like an un-coalesced pump: once 16 KiB wait in total, wait for the sends.
            if (pendingBytes + queuedBytes >= COALESCE_BYTES) {
              if (!(await flush())) return;
            } else {
              scheduleFlush();
            }
          }
          await flush();
        } catch (error) {
          // e.g. client-side validation of a stream message: the caller gets that error (a 400),
          // not a truncated stream (was a 502)
          failure ??= error as Error;
          ws.close(WS_CLOSE_CANCELLED, 'input failed');
        } finally {
          await flushing;
          closeChannel();
        }
      }
      const onAbort = () => ws.close(WS_CLOSE_CANCELLED, 'cancelled');
      signal.addEventListener('abort', onAbort, { once: true });

      let rejectOpen: ((reason: unknown) => void) | undefined;
      const abortOpen = () => rejectOpen?.(signal.reason);
      signal.addEventListener('abort', abortOpen, { once: true });
      try {
        await new Promise<void>((resolve, reject) => {
          rejectOpen = reject;
          ws.onopen = () => resolve();
          ws.onerror = () => reject(new Error(`WebSocket connection to ${url} failed`));
        });
        if (ws.protocol !== WS_SUBPROTOCOL) throw new Error(`server did not accept subprotocol ${WS_SUBPROTOCOL}`);
      } catch (error) {
        // No response body will run its cleanup: release the listeners and the socket here.
        signal.removeEventListener('abort', onAbort);
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(signal.aborted ? WS_CLOSE_CANCELLED : WS_CLOSE_PROTOCOL, 'handshake failed');
        throw error;
      } finally {
        signal.removeEventListener('abort', abortOpen);
      }

      if (receiveWindow > WS_INITIAL_WINDOW) {
        ws.send(String(receiveWindow - WS_INITIAL_WINDOW));
        receiveAllowance += receiveWindow - WS_INITIAL_WINDOW;
      }
      void pump(body);

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
  const ws = webSocketTransport(baseUrl, { http });
  const streamingFetch = supportsRequestStreams();
  return {
    async close() {
      await ws.close?.(); // its live WebSockets; the shared fetch transport is ours
      await http.close?.();
    },
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
