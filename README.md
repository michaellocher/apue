# apü

Spikes for a new HTTP/2-native API protocol. Design: [`SPEC-DRAFT.md`](SPEC-DRAFT.md) · research: [`research/`](research/).

Requires Node ≥ 26.11 (native TypeScript, no build step) and `openssl` (tests generate a throwaway cert).

```sh
npm install          # typescript + @types/node, for typechecking only
npm test             # node --test
npm run typecheck    # tsc (noEmit, erasableSyntaxOnly)
npm run ttfb         # TTFB + throughput measurement
npm run certs        # dev cert in certs/ for running a server manually
```

| Path | |
|---|---|
| `src/frame.ts` | frame codec (web-only, runs in browsers) |
| `src/protocol.ts` | media types, headers, `ApueError` |
| `src/server.ts` | node:http2 server, `FrameWriter` (coalescing, backpressure, heartbeat) |
| `src/client.ts` | `ApueClient` + fetch transport |
| `src/transport-http2.ts` | node:http2 transport (full duplex) |
