// apü client spike (S1). Web-platform only; transports are pluggable.
import { decodeFrames, decodeJson, endFrame, FrameType, msgFrame, concatBytes, type EndInfo } from './frame.ts';
import { ApueError, baseMediaType, Header, MediaType } from './protocol.ts';

export interface TransportRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Uint8Array | AsyncIterable<Uint8Array>;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array>;
}

export interface Transport {
  request(request: TransportRequest): Promise<TransportResponse>;
  close?(): Promise<void>;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Sent as `apue-timeout`; the server aborts the call and answers 504 after this many ms. */
  timeoutMs?: number;
}

const ACCEPT = `${MediaType.STREAM_JSON}, ${MediaType.JSON};q=0.9, ${MediaType.PROBLEM};q=0.8`;

export class ApueClient {
  #transport: Transport;

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /** Unary call. A streaming response is collected into an array. */
  async call<T = unknown>(op: string, input?: unknown, options?: CallOptions): Promise<T> {
    const body = input === undefined ? undefined : new TextEncoder().encode(JSON.stringify(input));
    const out: unknown[] = [];
    let streamed = false;
    for await (const item of this.#run(op, body, MediaType.JSON, options, () => (streamed = true))) out.push(item);
    return (streamed ? out : out[0]) as T;
  }

  /** Server-streaming call. Breaking out of the loop cancels the call. */
  stream<T = unknown>(op: string, input?: unknown, options?: CallOptions): AsyncGenerator<T> {
    const body = input === undefined ? undefined : new TextEncoder().encode(JSON.stringify(input));
    return this.#run(op, body, MediaType.JSON, options) as AsyncGenerator<T>;
  }

  /** Client-/bidi-streaming call. Full duplex depends on the transport (§8 tiers). */
  duplex<T = unknown>(op: string, inputs: AsyncIterable<unknown>, options?: CallOptions): AsyncGenerator<T> {
    return this.#run(op, encodeInputs(inputs), MediaType.STREAM_JSON, options) as AsyncGenerator<T>;
  }

  close(): Promise<void> {
    return this.#transport.close?.() ?? Promise.resolve();
  }

  async *#run(
    op: string,
    body: TransportRequest['body'],
    contentType: string,
    options: CallOptions = {},
    onStream?: () => void,
  ): AsyncGenerator<unknown> {
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const headers: Record<string, string> = { accept: ACCEPT, 'content-type': contentType };
    if (options.timeoutMs !== undefined) headers[Header.TIMEOUT] = String(options.timeoutMs);
    let finished = false;
    try {
      const res = await this.#transport.request({
        method: 'POST',
        path: `/${encodeURIComponent(op)}`,
        headers,
        ...(body === undefined ? {} : { body }),
        signal,
      });
      const type = baseMediaType(res.headers.get('content-type'));
      if (type === MediaType.STREAM_JSON && res.status === 200) {
        onStream?.();
        for await (const frame of decodeFrames(res.body)) {
          if (frame.type === FrameType.MSG) {
            yield decodeJson(frame.payload);
          } else if (frame.type === FrameType.END) {
            const info = decodeJson(frame.payload) as EndInfo;
            finished = true;
            if (info.status >= 400) throw ApueError.fromProblem(info.problem, info.status);
            return;
          }
          // HEARTBEAT, CHECKPOINT, unknown types: ignored in S1.
        }
        throw new ApueError(502, 'Truncated Stream', 'response ended without END frame');
      }
      const bytes = await readAll(res.body);
      finished = true;
      if (type === MediaType.PROBLEM || res.status >= 400) {
        throw ApueError.fromProblem(bytes.byteLength ? (decodeJson(bytes) as never) : undefined, res.status);
      }
      if (type !== MediaType.JSON) throw new ApueError(502, 'Unexpected Content-Type', type);
      yield decodeJson(bytes);
    } finally {
      if (!finished) controller.abort();
    }
  }
}

async function* encodeInputs(inputs: AsyncIterable<unknown>): AsyncGenerator<Uint8Array> {
  for await (const value of inputs) yield msgFrame(value);
  yield endFrame({ status: 200 });
}

async function readAll(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  return length === 0 ? new Uint8Array(0) : concatBytes(chunks, length);
}

// ---------------------------------------------------------------------------------------------
// fetch transport: tier T0 everywhere; streaming request bodies (T2) need h2 and Chromium or Node.

export function fetchTransport(baseUrl: string, fetchImpl: typeof fetch = fetch): Transport {
  const base = baseUrl.replace(/\/$/, '');
  return {
    async request({ method, path, headers, body, signal }) {
      const streaming = body !== undefined && !(body instanceof Uint8Array);
      const init: RequestInit & { duplex?: 'half' } = {
        method,
        headers,
        signal,
        ...(body === undefined ? {} : { body: streaming ? toReadableStream(body) : (body as BodyInit) }),
        ...(streaming ? { duplex: 'half' } : {}),
      };
      const res = await fetchImpl(base + path, init);
      return {
        status: res.status,
        headers: res.headers,
        body: res.body ? fromReadableStream(res.body) : emptyBody(),
      };
    },
  };
}

function toReadableStream(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}

// Safari has no async iteration on ReadableStream, so go through a reader.
async function* fromReadableStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let done = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function* emptyBody(): AsyncGenerator<Uint8Array> {}
