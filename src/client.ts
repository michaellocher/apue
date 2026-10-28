// apü client: typed from the API definition (TS-first, no codegen). Web-platform only; transports
// are pluggable (fetch here, node:http2 in transport-http2.ts).
import {
  canonicalJson,
  hasRequestStream,
  isCacheableRead,
  MAX_GET_URL,
  readPath,
  type Api,
  type InputOf,
  type OpDef,
  type OutputOf,
  type StreamKind,
} from './api.ts';
import { concatBytes, decodeFrameBatches, decodeJson, FrameError, endFrame, FrameType, msgFrame, type EndInfo, type Problem } from './frame.ts';
import { ApueError, baseMediaType, Header, MediaType, ProblemType } from './protocol.ts';
import { BlobAssembler, messageFrames } from './blobs.ts';
import { containsBytes, ValidationError } from './schema.ts';
import { canonicalSelection } from './select.ts';
import { Batch } from './batch.ts';

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
  /** Optional fast path for reading the whole body (unary responses); consumes `body`. */
  bytes?(): Promise<Uint8Array>;
}

export interface Transport {
  request(request: TransportRequest): Promise<TransportResponse>;
  close?(): Promise<void>;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Sent as `apue-timeout`; the server aborts the call and answers 504 after this many ms. */
  timeoutMs?: number;
  /** Overrides the generated Idempotency-Key of a non-safe unary call. */
  idempotencyKey?: string;
  /** Overrides the client's retry budget for this call. */
  retries?: number;
  /** Resumable streams: how often to resume after a lost connection (default 3). */
  resumes?: number;
  /** Field selection (`?s=`): only these output fields are sent. Prefer the typed `pick()`. */
  select?: readonly string[];
}

type PrevDepth = [never, 0, 1, 2, 3];
/** Dotted paths into an output type (through arrays and optional fields, up to 4 levels). */
export type FieldPath<T, D extends number = 4> = [D] extends [never]
  ? never
  : T extends readonly (infer E)[]
    ? FieldPath<E, D>
    : T extends object
      ? { [K in keyof T & string]: K | (NonNullable<T[K]> extends object ? `${K}.${FieldPath<NonNullable<T[K]>, PrevDepth[D]>}` : never) }[keyof T & string]
      : never;

export type DeepPartial<T> = T extends readonly (infer E)[] ? DeepPartial<E>[] : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export interface ClientOptions {
  /** Retries for retry-eligible calls (safe, idempotent, or keyed). Default 2. */
  retries?: number;
  /** Base backoff; attempt n waits a random time in [0, base·2ⁿ] (full jitter), capped at maxBackoffMs. */
  backoffMs?: number;
  maxBackoffMs?: number;
}

export type OpsOf<A extends Api, S extends StreamKind> = {
  [K in keyof A & string]: A[K] extends OpDef<any, any, infer X> ? ([X] extends [S] ? K : never) : never;
}[keyof A & string];

export type Args<D> = undefined extends InputOf<D>
  ? [input?: InputOf<D>, options?: CallOptions]
  : [input: InputOf<D>, options?: CallOptions];

const QUERY_REJECTED = new Set([400, 403, 405, 501]);
export const ACCEPT = `${MediaType.STREAM_JSON}, ${MediaType.JSON};q=0.9, ${MediaType.PROBLEM};q=0.8`;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface Prepared {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: TransportRequest['body'];
}

export class ApueClient<A extends Api> {
  #api: A;
  #transport: Transport;
  #retries: number;
  #backoffMs: number;
  #maxBackoffMs: number;
  /** Set once the server (or an intermediary) rejects QUERY; reads then fall back to POST. */
  #queryUnsupported = false;

  constructor(api: A, transport: Transport, options: ClientOptions = {}) {
    this.#api = api;
    this.#transport = transport;
    this.#retries = options.retries ?? 2;
    this.#backoffMs = options.backoffMs ?? 100;
    this.#maxBackoffMs = options.maxBackoffMs ?? 2_000;
  }

  /** Unary call. (No async generator on this path: bench S4 showed it in the per-call cost.) */
  async call<K extends OpsOf<A, 'none'>>(op: K, ...[input, options = {}]: Args<A[K]>): Promise<OutputOf<A[K]>> {
    const def = this.#definition(op);
    const controller = new AbortController();
    const unlink = linkSignal(options.signal, controller);
    try {
      const res = await this.#send(op, def, input, options, controller.signal);
      const type = baseMediaType(res.headers.get('content-type'));
      // Ops whose output contains bytes are answered framed (MSG + BLOB frames + END).
      if (type === MediaType.STREAM_JSON && res.status === 200) return (await readFramedValue(res.body)) as OutputOf<A[K]>;
      const bytes = res.bytes ? await res.bytes() : await readAll(res.body);
      if (type === MediaType.PROBLEM || res.status >= 400) throw problemError(bytes, res.status);
      if (type !== MediaType.JSON) throw new ApueError(502, 'Unexpected Content-Type', type);
      return decodeJson(bytes) as OutputOf<A[K]>;
    } catch (error) {
      controller.abort();
      // Transports report aborts differently (fetch: the reason, node:http2: AbortError); callers
      // always get their own abort reason.
      if (options.signal?.aborted) throw options.signal.reason;
      throw asProtocolError(error);
    } finally {
      unlink();
    }
  }

  /** Unary call returning only the selected fields (avoids over-fetching; part of the GET cache key). */
  pick<K extends OpsOf<A, 'none'>>(
    op: K,
    input: InputOf<A[K]>,
    select: readonly FieldPath<OutputOf<A[K]>>[],
    options: Omit<CallOptions, 'select'> = {},
  ): Promise<DeepPartial<OutputOf<A[K]>>> {
    return (this.call as (op: string, input: unknown, options: CallOptions) => Promise<DeepPartial<OutputOf<A[K]>>>)(op, input, { ...options, select });
  }

  /** Server-streaming call. Breaking out of the loop cancels the call on the server. */
  stream<K extends OpsOf<A, 'server'>>(op: K, ...[input, options]: Args<A[K]>): AsyncGenerator<OutputOf<A[K]>> {
    return this.#run(op, input, options) as AsyncGenerator<OutputOf<A[K]>>;
  }

  /** Client- or bidi-streaming call. Full duplex depends on the transport (§8 tiers). */
  duplex<K extends OpsOf<A, 'client' | 'bidi'>>(
    op: K,
    inputs: AsyncIterable<InputOf<A[K]>>,
    options?: CallOptions,
  ): AsyncGenerator<OutputOf<A[K]>> {
    return this.#run(op, inputs, options) as AsyncGenerator<OutputOf<A[K]>>;
  }

  close(): Promise<void> {
    return this.#transport.close?.() ?? Promise.resolve();
  }

  /** Starts a pipelined batch: dependent calls in one round trip (SPEC-DRAFT §10). */
  batch(): Batch<A> {
    return new Batch(this.#api, this);
  }

  /** @internal */
  get queryAllowed(): boolean {
    return !this.#queryUnsupported;
  }

  /** @internal */
  get retryBudget(): number {
    return this.#retries;
  }

  #definition(opName: string): OpDef {
    const def = this.#api[opName];
    if (!def) throw new ApueError(404, 'Unknown Operation', opName, { type: ProblemType.UNKNOWN_OPERATION });
    return def;
  }

  async *#run(opName: string, input: unknown, options: CallOptions = {}): AsyncGenerator<unknown> {
    const def = this.#definition(opName);
    const controller = new AbortController();
    const unlink = linkSignal(options.signal, controller);
    let finished = false;
    let resumeToken: string | undefined;
    let resumes = 0;
    // Messages received after the last checkpoint are re-sent on resume (the server replays from
    // the cursor): skip exactly that many so the consumer sees every item once.
    let sinceCheckpoint = 0;
    let skip = 0;
    try {
      for (;;) {
        const res = await this.#send(opName, def, input, options, controller.signal, resumeToken);
        const type = baseMediaType(res.headers.get('content-type'));
        if (type !== MediaType.STREAM_JSON || res.status !== 200) {
          const bytes = await readAll(res.body);
          finished = true;
          if (type === MediaType.PROBLEM || res.status >= 400) throw problemError(bytes, res.status);
          if (type !== MediaType.JSON) throw new ApueError(502, 'Unexpected Content-Type', type);
          yield decodeJson(bytes);
          return;
        }
        // Blob framing (and its escaping) is used exactly for ops whose output contains bytes.
        const assembler = containsBytes(def.output) ? new BlobAssembler() : undefined;
        try {
          for await (const frames of decodeFrameBatches(res.body)) {
            for (const frame of frames) {
              if (frame.type === FrameType.MSG) {
                const value = assembler ? assembler.resolve(decodeJson(frame.payload)) : decodeJson(frame.payload);
                sinceCheckpoint++;
                if (skip > 0) {
                  skip--;
                  continue;
                }
                yield value;
              } else if (frame.type === FrameType.BLOB) {
                if (!assembler) throw new FrameError('BLOB frame for an op without bytes');
                assembler.push(frame);
              } else if (frame.type === FrameType.CHECKPOINT) {
                resumeToken = textDecoder.decode(frame.payload);
                sinceCheckpoint = 0;
                skip = 0;
              } else if (frame.type === FrameType.END) {
                const info = decodeJson(frame.payload) as EndInfo;
                finished = true;
                if (info.status >= 400) throw ApueError.fromProblem(info.problem, info.status);
                return;
              }
              // HEARTBEAT and unknown frame types are ignored.
            }
          }
          throw new ApueError(502, 'Truncated Stream', 'response ended without END frame', { type: ProblemType.TRUNCATED_STREAM });
        } catch (error) {
          // Resume only after the transport lost the stream (not after an END with an error, not
          // for malformed frames), only with a checkpoint, and within the budget.
          const resumable =
            !finished &&
            def.resumable === true &&
            resumeToken !== undefined &&
            resumes < (options.resumes ?? 3) &&
            !controller.signal.aborted &&
            !(error instanceof FrameError) &&
            !(error instanceof SyntaxError);
          if (!resumable) throw error;
          // Skipped-but-not-yet-replayed items still count: a loss during the replay must not
          // shrink the window of items the consumer has already seen.
          skip += sinceCheckpoint;
          sinceCheckpoint = 0;
          resumes++;
          await sleep(this.#backoff(resumes - 1), controller.signal);
        }
      }
    } catch (error) {
      // Transports report aborts differently (fetch: the reason, node:http2: AbortError); callers
      // always get their own abort reason.
      if (options.signal?.aborted) throw options.signal.reason;
      throw asProtocolError(error);
    } finally {
      unlink();
      if (!finished) controller.abort();
    }
  }

  #prepare(opName: string, def: OpDef, input: unknown, options: CallOptions, resumeToken?: string): Prepared {
    const headers: Record<string, string> = { accept: ACCEPT };
    if (options.timeoutMs !== undefined) headers[Header.TIMEOUT] = String(options.timeoutMs);
    if (resumeToken !== undefined) headers[Header.RESUME] = resumeToken;
    if (hasRequestStream(def)) {
      headers['content-type'] = MediaType.STREAM_JSON;
      // RFC 10036 §3: must be set on the request too, or intermediaries may buffer the upload.
      headers.incremental = '?1';
      return { method: 'POST', path: `/${opName}`, headers, body: encodeInputs(input as AsyncIterable<unknown>, def) };
    }
    const value = validate(def, input, 'input');
    const select = options.select?.length ? `s=${encodeURIComponent(canonicalSelection(options.select))}` : '';
    if (isCacheableRead(def)) {
      const readUrl = readPath(opName, value);
      const getPath = select ? `${readUrl}${readUrl.includes('?') ? '&' : '?'}${select}` : readUrl;
      if (getPath.length <= MAX_GET_URL) return { method: 'GET', path: getPath, headers };
    }
    if (value !== undefined) headers['content-type'] = MediaType.JSON;
    const body = value === undefined ? undefined : textEncoder.encode(canonicalJson(value));
    const method = isCacheableRead(def) && this.queryAllowed ? 'QUERY' : 'POST';
    if (def.effect !== 'safe' && def.stream === 'none') {
      headers['idempotency-key'] = sfString(options.idempotencyKey ?? crypto.randomUUID());
    }
    return { method, path: `/${opName}${select ? `?${select}` : ''}`, headers, ...(body === undefined ? {} : { body }) };
  }

  #send(opName: string, def: OpDef, input: unknown, options: CallOptions, signal: AbortSignal, resumeToken?: string): Promise<TransportResponse> {
    // A request stream can't be replayed; everything else is safe to resend because it is safe,
    // idempotent, or carries an Idempotency-Key.
    const budget = hasRequestStream(def) ? 0 : (options.retries ?? this.#retries);
    return this.sendPrepared(this.#prepare(opName, def, input, options, resumeToken), budget, signal);
  }

  /** @internal Sends with QUERY→POST fallback and retries; used by calls and batches. */
  async sendPrepared(prepared: Prepared, budget: number, signal: AbortSignal): Promise<TransportResponse> {
    let queryRejectedWith: number | undefined;
    for (let attempt = 0; ; attempt++) {
      // Per-attempt signal: aborting it discards a response we won't use (resets the h2 stream).
      // Merely returning an unstarted body iterator would leave the stream open.
      const attemptController = new AbortController();
      const unlinkAttempt = linkSignal(signal, attemptController);
      let res: TransportResponse;
      try {
        res = await this.#transport.request({ ...prepared, signal: attemptController.signal });
      } catch (error) {
        unlinkAttempt();
        if (signal.aborted || attempt >= budget) throw error;
        await sleep(this.#backoff(attempt), signal);
        continue;
      }
      // Intermediaries without QUERY support answer 405/501 (Akamai), 403 (CloudFront) or 400
      // (Envoy < 1.40 on HTTP/1). Retry the read as POST; remember only if POST then fares better.
      if (prepared.method === 'QUERY' && QUERY_REJECTED.has(res.status)) {
        attemptController.abort();
        unlinkAttempt();
        queryRejectedWith = res.status;
        prepared = { ...prepared, method: 'POST' };
        attempt--; // a method fallback is not a retry
        continue;
      }
      if (queryRejectedWith !== undefined && res.status !== queryRejectedWith) this.#queryUnsupported = true;
      if (attempt < budget) {
        const delay = await this.#retryDelay(res, attempt);
        if (delay !== undefined) {
          attemptController.abort();
          unlinkAttempt();
          await sleep(delay, signal);
          continue;
        }
      }
      return res;
    }
  }

  /** Returns a delay if the response is a retryable failure, else undefined. Never consumes non-409 bodies. */
  async #retryDelay(res: TransportResponse, attempt: number): Promise<number | undefined> {
    if (res.status === 503 || res.status === 429) {
      const delay = retryAfterMs(res.headers.get('retry-after'));
      return delay === undefined ? this.#backoff(attempt) : Math.min(delay, this.#maxBackoffMs);
    }
    if (res.status === 409 && baseMediaType(res.headers.get('content-type')) === MediaType.PROBLEM) {
      // 409 is only retryable when the server says so (Idempotency-Key still in progress).
      const bytes = await readAll(res.body);
      const problem = safeJson(bytes) as Partial<Problem> | undefined;
      if (problem?.retryable === true) return this.#backoff(attempt);
      // The body is consumed: both accessors must now serve the buffered bytes.
      res.body = single(bytes);
      res.bytes = () => Promise.resolve(bytes);
    }
    return undefined;
  }

  #backoff(attempt: number): number {
    return Math.random() * Math.min(this.#maxBackoffMs, this.#backoffMs * 2 ** attempt);
  }
}

// ---------------------------------------------------------------------------------------------

/** Retry-After (RFC 9110 §10.2.3): delay-seconds or an HTTP-date; undefined if absent or invalid. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) || !/[a-z]/i.test(value) ? undefined : Math.max(0, date - now);
}

export function validate(def: OpDef, value: unknown, what: string): unknown {
  try {
    return def.input.parse(value);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ApueError(400, 'Validation Failed', `${what} does not match the schema`, { type: ProblemType.VALIDATION, fields: error.issues });
    }
    throw error;
  }
}

async function* encodeInputs(inputs: AsyncIterable<unknown>, def: OpDef): AsyncGenerator<Uint8Array> {
  let index = 0;
  const blobs = containsBytes(def.input);
  for await (const value of inputs) {
    const valid = validate(def, value, `input message ${index++}`);
    if (blobs) yield* messageFrames(valid);
    else yield msgFrame(valid);
  }
  yield endFrame({ status: 200 });
}

/** RFC 9651 sf-string. */
function sfString(value: string): string {
  if (!/^[\x20-\x7e]*$/.test(value)) throw new TypeError('Idempotency-Key must be printable ASCII');
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

export function problemError(bytes: Uint8Array, status: number): ApueError {
  return ApueError.fromProblem(safeJson(bytes) as Partial<Problem> | undefined, status);
}

function safeJson(bytes: Uint8Array): unknown {
  try {
    return bytes.byteLength ? decodeJson(bytes) : undefined;
  } catch {
    return undefined;
  }
}

export async function readAll(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  return length === 0 ? new Uint8Array(0) : concatBytes(chunks, length);
}

async function* single(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/** Reads a framed response that carries exactly one value (unary ops with bytes in the output). */
async function readFramedValue(body: AsyncIterable<Uint8Array>): Promise<unknown> {
  const assembler = new BlobAssembler();
  let value: unknown;
  for await (const frames of decodeFrameBatches(body)) {
    for (const frame of frames) {
      if (frame.type === FrameType.BLOB) assembler.push(frame);
      else if (frame.type === FrameType.MSG) value = assembler.resolve(decodeJson(frame.payload));
      else if (frame.type === FrameType.END) {
        const info = decodeJson(frame.payload) as EndInfo;
        if (info.status >= 400) throw ApueError.fromProblem(info.problem, info.status);
        return value;
      }
    }
  }
  throw new ApueError(502, 'Truncated Stream', 'response ended without END frame', { type: ProblemType.TRUNCATED_STREAM });
}

/** A response that can't be decoded (bad framing, invalid JSON) is a bad gateway, not a crash. */
export function asProtocolError(error: unknown): unknown {
  if (error instanceof FrameError || error instanceof SyntaxError) {
    return new ApueError(502, 'Malformed Stream', error.message, { type: ProblemType.MALFORMED_STREAM });
  }
  return error;
}

/**
 * Aborts `child` when `parent` aborts; returns an unlink function. Replaces AbortSignal.any,
 * which costs ~2.7 µs per call on Node 26 (bench S4) — more than a whole loopback request's share.
 */
export function linkSignal(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (!parent) return noop;
  if (parent.aborted) {
    child.abort(parent.reason);
    return noop;
  }
  const onAbort = () => child.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  return () => parent.removeEventListener('abort', onAbort);
}

const noop = () => {};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------------------------
// fetch transport: tier T0 everywhere; streaming request bodies (T2) need h2 and Chromium or Node.

export interface FetchTransportOptions {
  fetch?: typeof fetch;
  /**
   * Cross-origin fetches default to no credentials, while WebSockets always send them; Chrome
   * then can't share the HTTP/2 connection with a WebSocket (different session key) and opens
   * HTTP/1.1. 'include' lets WebSockets reuse the h2 connection (needs CORS credentials).
   */
  credentials?: RequestCredentials;
}

export function fetchTransport(baseUrl: string, options: FetchTransportOptions | typeof fetch = {}): Transport {
  const { fetch: fetchImpl = fetch, credentials } = typeof options === 'function' ? { fetch: options, credentials: undefined } : options;
  const base = baseUrl.replace(/\/$/, '');
  return {
    async request({ method, path, headers, body, signal }) {
      const streaming = body !== undefined && !(body instanceof Uint8Array);
      const init: RequestInit & { duplex?: 'half' } = {
        method,
        headers,
        signal,
        ...(credentials ? { credentials } : {}),
        ...(body === undefined ? {} : { body: streaming ? toReadableStream(body) : (body as BodyInit) }),
        ...(streaming ? { duplex: 'half' } : {}),
      };
      let res: Response;
      try {
        res = await fetchImpl(base + path, init);
      } catch (error) {
        // fetch wraps errors thrown by a streaming request body (e.g. client-side validation).
        if (error instanceof TypeError && error.cause instanceof ApueError) throw error.cause;
        throw error;
      }
      return {
        status: res.status,
        headers: res.headers,
        body: res.body ? fromReadableStream(res.body) : single(new Uint8Array(0)),
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
