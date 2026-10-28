// Client side of pipelined batches (SPEC-DRAFT §10): dependent calls in one round trip, results
// streamed back per lane as each call completes. Web-only.
import { canonicalJson, type Api, type InputOf, type OpDef, type OutputOf } from './api.ts';
import { ACCEPT, asProtocolError, linkSignal, problemError, readAll, validate, type ApueClient, type CallOptions, type OpsOf, type Prepared } from './client.ts';
import { decodeFrameBatches, decodeJson, FrameType, type EndInfo } from './frame.ts';
import { ApueError, baseMediaType, MediaType, ProblemType } from './protocol.ts';
import { containsRef, encodeArgs, Ref } from './refs.ts';

/** Following a path through optional fields: a missing value fails the lane at runtime (400). */
type Step<T, K extends keyof NonNullable<T>> = NonNullable<NonNullable<T>[K]>;

type BatchArgs<D> = undefined extends InputOf<D> ? [input?: InputOf<D>] : [input: InputOf<D>];

interface LaneSink {
  msg(value: unknown): void;
  end(info: EndInfo): void;
  fail(error: unknown): void;
}

/** A unary call inside a batch. `result` settles as soon as its lane ends. */
export class BatchCall<O> implements LaneSink {
  readonly lane: number;
  readonly result: Promise<O>;
  #value: unknown;
  #resolve!: (value: O) => void;
  #reject!: (error: unknown) => void;

  constructor(lane: number) {
    this.lane = lane;
    this.result = new Promise<O>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // Lane failures are reported through `result`; don't crash the process if nobody awaits it.
    this.result.catch(() => {});
  }

  /** A reference to this call's output (or a field of it), usable inside later calls' inputs. */
  ref(): O;
  ref<K1 extends keyof O>(k1: K1): O[K1];
  ref<K1 extends keyof O, K2 extends keyof Step<O, K1>>(k1: K1, k2: K2): Step<Step<O, K1>, K2>;
  ref<K1 extends keyof O, K2 extends keyof Step<O, K1>, K3 extends keyof Step<Step<O, K1>, K2>>(
    k1: K1,
    k2: K2,
    k3: K3,
  ): Step<Step<Step<O, K1>, K2>, K3>;
  ref(...path: Array<string | number | symbol>): unknown {
    if (path.some((segment) => typeof segment === 'symbol')) throw new TypeError('ref path segments must be strings or numbers');
    return new Ref(this.lane, path as Array<string | number>);
  }

  msg(value: unknown): void {
    this.#value = value;
  }

  end(info: EndInfo): void {
    if (info.status >= 400) this.#reject(ApueError.fromProblem(info.problem, info.status));
    else this.#resolve(this.#value as O);
  }

  fail(error: unknown): void {
    this.#reject(error);
  }
}

/** A server-streaming call inside a batch. Items are buffered until consumed. */
export class BatchStream<O> implements LaneSink, AsyncIterable<O> {
  readonly lane: number;
  #items: O[] = [];
  #done = false;
  #error: unknown;
  #wake: (() => void) | undefined;

  constructor(lane: number) {
    this.lane = lane;
  }

  msg(value: unknown): void {
    this.#items.push(value as O);
    this.#notify();
  }

  end(info: EndInfo): void {
    if (info.status >= 400) this.#error = ApueError.fromProblem(info.problem, info.status);
    this.#done = true;
    this.#notify();
  }

  fail(error: unknown): void {
    this.#error = error;
    this.#done = true;
    this.#notify();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<O> {
    for (;;) {
      while (this.#items.length > 0) yield this.#items.shift()!;
      if (this.#done) {
        if (this.#error !== undefined) throw this.#error;
        return;
      }
      await new Promise<void>((resolve) => (this.#wake = resolve));
    }
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}

interface Entry {
  op: string;
  def: OpDef;
  input: unknown;
  sink: LaneSink;
}

export class Batch<A extends Api> {
  #api: A;
  #client: ApueClient<A>;
  #entries: Entry[] = [];
  #sent = false;

  constructor(api: A, client: ApueClient<A>) {
    this.#api = api;
    this.#client = client;
  }

  call<K extends OpsOf<A, 'none'>>(op: K, ...[input]: BatchArgs<A[K]>): BatchCall<OutputOf<A[K]>> {
    return this.#add(op, input, new BatchCall<OutputOf<A[K]>>(this.#entries.length));
  }

  stream<K extends OpsOf<A, 'server'>>(op: K, ...[input]: BatchArgs<A[K]>): BatchStream<OutputOf<A[K]>> {
    return this.#add(op, input, new BatchStream<OutputOf<A[K]>>(this.#entries.length));
  }

  /**
   * Sends all calls in one request and resolves once every lane has ended. Individual call
   * failures settle their own `result` (or stream); `send` only rejects if the batch as a whole fails.
   */
  async send(options: CallOptions = {}): Promise<void> {
    if (this.#sent) throw new Error('batch already sent');
    if (this.#entries.length === 0) throw new Error('batch is empty');
    this.#sent = true;
    const sinks = this.#entries.map((entry) => entry.sink);
    try {
      await this.#run(options);
    } catch (caught) {
      // Transports report aborts differently (fetch: the reason, node:http2: AbortError); callers
      // always get their own abort reason.
      const error = options.signal?.aborted ? options.signal.reason : asProtocolError(caught);
      for (const sink of sinks) sink.fail(error);
      throw error;
    }
  }

  #add<S extends LaneSink & { lane: number }>(op: string, input: unknown, sink: S): S {
    if (this.#sent) throw new Error('batch already sent');
    const def = this.#api[op];
    if (!def) throw new ApueError(404, 'Unknown Operation', op, { type: ProblemType.UNKNOWN_OPERATION });
    for (const lane of lanesOf(input)) {
      if (lane >= sink.lane) throw new Error(`ref to call ${lane} must come from an earlier call in this batch`);
    }
    // Inputs containing refs can only be validated on the server, after resolution.
    const value = containsRef(input) ? input : validate(def, input, `input of call ${sink.lane}`);
    this.#entries.push({ op, def, input: value, sink });
    return sink;
  }

  async #run(options: CallOptions): Promise<void> {
    const allSafe = this.#entries.every((entry) => entry.def.effect === 'safe');
    const calls = this.#entries.map(({ op, def, input }) => ({
      op,
      ...(input === undefined ? {} : { in: encodeArgs(input) }),
      // Keys make non-safe calls replay-safe, so the whole batch can be retried.
      ...(def.effect === 'safe' ? {} : { key: crypto.randomUUID() }),
    }));
    const headers: Record<string, string> = { accept: ACCEPT, 'content-type': MediaType.JSON };
    if (options.timeoutMs !== undefined) headers['apue-timeout'] = String(options.timeoutMs);
    const prepared: Prepared = {
      method: allSafe && this.#client.queryAllowed ? 'QUERY' : 'POST',
      path: '/$batch',
      headers,
      body: new TextEncoder().encode(canonicalJson({ calls })),
    };
    const controller = new AbortController();
    const unlink = linkSignal(options.signal, controller);
    let finished = false;
    try {
      const res = await this.#client.sendPrepared(prepared, options.retries ?? this.#client.retryBudget, controller.signal);
      if (res.status !== 200 || baseMediaType(res.headers.get('content-type')) !== MediaType.STREAM_JSON) {
        const bytes = await readAll(res.body);
        finished = true;
        throw problemError(bytes, res.status >= 400 ? res.status : 502);
      }
      const open = new Set(this.#entries.keys());
      for await (const frames of decodeFrameBatches(res.body)) {
        for (const frame of frames) {
          const sink = this.#entries[frame.lane]?.sink;
          if (!sink || !open.has(frame.lane)) continue;
          if (frame.type === FrameType.MSG) {
            sink.msg(decodeJson(frame.payload));
          } else if (frame.type === FrameType.END) {
            sink.end(decodeJson(frame.payload) as EndInfo);
            open.delete(frame.lane);
          }
        }
      }
      finished = true;
      if (open.size > 0) {
        const error = new ApueError(502, 'Truncated Stream', `lanes ${[...open].join(', ')} ended without END frame`, {
          type: ProblemType.TRUNCATED_STREAM,
        });
        for (const lane of open) this.#entries[lane]!.sink.fail(error);
      }
    } finally {
      unlink();
      if (!finished) controller.abort();
    }
  }
}

function lanesOf(value: unknown, lanes: number[] = []): number[] {
  if (value instanceof Ref) lanes.push(value.lane);
  else if (Array.isArray(value)) for (const item of value) lanesOf(item, lanes);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) lanesOf(item, lanes);
  return lanes;
}
