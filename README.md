# apü

A new API protocol in the family of REST, GraphQL, gRPC — designed from research on what those get
wrong, built purely on HTTP semantics (HTTP/2 first, HTTP/1.1 and HTTP/3-via-proxy compatible),
with maximum throughput, short TTFB, compression, multiplexing, duplex streaming and resumability.
Spikes in Node 26 with native TypeScript and no build step.

- Design: [`SPEC-DRAFT.md`](SPEC-DRAFT.md) (draft 01, marks what is implemented vs planned)
- On the wire: [`docs/wire.md`](docs/wire.md) — real curl sessions (idempotent replay, ETag/304, QUERY,
  selection, problem details, SSE view, a batch in hex)
- Research: [`research/`](research/) — problems of existing API styles, HTTP/2 and modern HTTP,
  data plane performance, Node 26 platform, verified normative details
- Measurements: [`docs/benchmarks.md`](docs/benchmarks.md) (local, constrained Docker, WAN
  emulation, vs gRPC/grpc-js: 1.5× unary, 30× streaming) · [`docs/intermediaries.md`](docs/intermediaries.md)
  (through nginx, Caddy, HAProxy, Envoy)

## In one minute

```ts
// api.ts — the contract, shared by server and clients (types + validation, no codegen)
export const api = defineApi({
  'users.get':    op({ effect: 'safe', input: t.object({ id: t.string() }), output: User, cache: { maxAge: 60 } }),
  'orders.create': op({ effect: 'unsafe', input: NewOrder, output: Order }),
  'orders.watch': op({ effect: 'safe', stream: 'server', resumable: true, input: t.void(), output: Order }),
});

// client
const client = new ApueClient(api, http2Transport('https://api.example'));
await client.call('users.get', { id: '42' });             // GET /users.get?i={"id":"42"} → cacheable, ETag
await client.pick('users.get', { id: '42' }, ['name']);    // only the fields you need
await client.call('orders.create', { item: 'book' });     // POST + Idempotency-Key → safe to retry
const b = client.batch();                                  // dependent calls, one round trip
const u = b.call('users.get', { id: '42' });
const o = b.call('orders.create', { item: 'book', userId: u.ref('id') });
await b.send();
for await (const order of client.stream('orders.watch')) {} // resumes after network loss
```

What happens on the wire: safe ops are `GET` (or `QUERY`, RFC 10008, for large inputs, with POST
fallback), errors are real HTTP status codes with RFC 9457 problem details, streams are
length-prefixed frames ending with an in-band status, responses are compressed (zstd/br/gzip) and
streamed with flushes per burst, and the same frames run over WebSocket where browsers can't
stream request bodies.

## Try it

```sh
node examples/todo/server.ts     # https://localhost:8443 — open it in a browser (self-signed cert)
node examples/todo/cli.ts        # typed calls, a pipelined batch, a resumable change stream
```

The example ([`examples/todo`](examples/todo)) serves page and API from one origin; the browser
imports `src/*.ts` type-stripped by the server (no build step).

## Develop

Requires Node ≥ 26.11 (native TypeScript, no build step) and `openssl` (tests generate a throwaway
cert). Optional: Chrome/Firefox for the real-browser tests, Docker for constrained benchmarks and
the nginx probe.

```sh
npm install          # dev only: typescript + @types/node (typecheck), @grpc/* (gRPC benchmark)
npm test             # node --test: 182 tests incl. headless Chrome + Firefox (skipped if absent)
npm run typecheck    # tsc (noEmit, erasableSyntaxOnly)
node bench/run.ts    # benchmarks vs raw node:http2 baselines (separate processes)
bench/docker.sh      # same on CPU/RAM-limited containers, incl. emulated WAN (netem)
bench/proxy/run.sh   # behaviour through real nginx, Caddy, HAProxy and Envoy (Docker)
node bench/micro.ts  # data-path micro-benchmarks
```

## Implemented

| Area | Where |
|---|---|
| Contracts: TS-first schemas with inference, JSON Schema export, field selection | `src/schema.ts`, `src/api.ts`, `src/select.ts` |
| HTTP mapping: GET/QUERY/POST/HEAD by effect, RFC 8785 canonical inputs, ETag/304, cache policy, Deprecation/Sunset | `src/server.ts`, `src/client.ts` |
| Errors: RFC 9457 problem types, early real status for streams, in-band END | `src/protocol.ts`, `src/server.ts` |
| Idempotency-Key replay (409/422 semantics), client retries with backoff | `src/idempotency.ts`, `src/client.ts` |
| Framing (8-byte header), coalescing writer, heartbeats, SSE rendering | `src/frame.ts`, `src/server.ts` |
| Binary values (`t.bytes()`) as raw BLOB frames — no base64 | `src/blobs.ts` |
| Pipelined batches with `$ref`, out-of-order lanes, 424 | `src/refs.ts`, `src/batch.ts` |
| Resumable streams with HMAC checkpoints (stateless, exactly-once) | `src/resume.ts` |
| Compression: zstd/br/gzip, per-burst flush | `src/compression.ts` |
| Transports: HTTP/2 core API + HTTP/1.1, fetch, node:http2 (full duplex), WebSocket (RFC 8441/6455) | `src/exchange.ts`, `src/transport-http2.ts`, `src/websocket.ts`, `src/transport-ws.ts` |
| CORS, resource limits (streams, idle, body time), manifest + RFC 9727 catalog | `src/server.ts` |
| Typed client contract from a running server's manifest (`node bin/apue-types.ts <url>`) | `src/codegen.ts`, `bin/apue-types.ts` |

Planned (see spec §13): CBOR, CREDIT flow control, WebTransport, resumable uploads, CDN cache headers.
