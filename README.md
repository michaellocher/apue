# apü

Spikes for a new HTTP/2-native API protocol. Design: [`SPEC-DRAFT.md`](SPEC-DRAFT.md) · research: [`research/`](research/).

## Try it

```sh
node examples/todo/server.ts     # https://localhost:8443 — open it in a browser (self-signed cert)
node examples/todo/cli.ts        # typed calls, a pipelined batch, a resumable change stream
```

The example ([`examples/todo`](examples/todo)) serves page and API from one origin; the browser
imports `src/*.ts` type-stripped by the server (no build step).

Requires Node ≥ 26.11 (native TypeScript, no build step) and `openssl` (tests generate a throwaway cert).

```sh
npm install          # typescript + @types/node, for typechecking only
npm test             # node --test
npm run typecheck    # tsc (noEmit, erasableSyntaxOnly)
npm run ttfb         # TTFB + throughput measurement
npm run certs        # dev cert in certs/ for running a server manually
node bench/run.ts    # benchmarks vs raw node:http2 baselines (separate processes)
bench/docker.sh      # same on CPU/RAM-limited containers, incl. emulated WAN (netem)
node bench/micro.ts  # data-path micro-benchmarks
```

`node --test` includes real-browser tests (headless Chrome via CDP, Firefox via WebDriver BiDi);
browsers that aren't installed are skipped. Override paths with `CHROME_PATH` / `FIREFOX_PATH`.

Benchmark results: [`docs/benchmarks.md`](docs/benchmarks.md). Behaviour through real nginx (`bench/proxy/run.sh`): [`docs/intermediaries.md`](docs/intermediaries.md).

| Path | |
|---|---|
| `src/schema.ts` | TS-first schema builder (validation, inference, JSON Schema) |
| `src/api.ts` | `op` / `defineApi`, effect → HTTP method rules, RFC 8785 canonical JSON |
| `src/idempotency.ts` | Idempotency-Key store |
| `src/refs.ts` | `$ref` / `$lit` encoding and resolution for batches |
| `src/batch.ts` | client batch API (pipelining) |
| `src/frame.ts` | frame codec (web-only, runs in browsers) |
| `src/protocol.ts` | media types, headers, `ApueError` |
| `src/server.ts` | node:http2 server, `FrameWriter` (coalescing, backpressure, heartbeat) |
| `src/client.ts` | typed `ApueClient` (method selection, retries) + fetch transport |
| `src/exchange.ts` | HTTP/2 core stream API / HTTP/1.1 behind one interface |
| `src/compression.ts` | Accept-Encoding negotiation, zstd/br/gzip, streaming flush |
| `src/transport-http2.ts` | node:http2 transport (full duplex) |
| `src/websocket.ts`, `src/transport-ws.ts` | tier T3: apü frames over WebSocket (RFC 8441 / RFC 6455), `autoTransport` for browsers |
