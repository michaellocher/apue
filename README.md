# apü

**Typed API operations on plain HTTP.** A peer to REST, GraphQL and gRPC: you declare operations
with their effect (`safe`, `idempotent`, `unsafe`) and schemas; apü maps them onto ordinary HTTP —
reads become cacheable `GET`s, writes carry idempotency keys, errors are real status codes with
RFC 9457 problem details — and adds streaming in every direction (also from browsers), resumable
streams and uploads, download links with Range support and pipelined batches. One TypeScript
definition validates on both sides and types handlers and clients; other languages get generated
clients from the server's manifest.

> **Beta.** `0.1.0-beta.x` releases may still change the wire format and APIs; every change is
> listed in [CHANGELOG.md](CHANGELOG.md). Website and docs: [apue.dev](https://apue.dev) ·
> design: [SPEC-DRAFT.md](SPEC-DRAFT.md).

## Install

```sh
npm install apue@beta
```

Node ≥ 26.11 for the server and the Node client; the web-safe core (`apue`, `apue/websocket`) runs
in browsers too. No runtime dependencies.

## Quick start

```ts
// api.ts — the contract, shared by server and clients
import { defineApi, op, t } from 'apue';

const Todo = t.object({ id: t.number({ int: true }), title: t.string({ min: 1, max: 200 }), done: t.boolean() });
export const api = defineApi({
  'todos.list':   op({ effect: 'safe', input: t.void(), output: t.array(Todo) }),
  'todos.create': op({ effect: 'unsafe', input: t.object({ title: t.string({ min: 1 }) }), output: Todo }),
  'todos.watch':  op({ effect: 'safe', stream: 'server', resumable: true, input: t.void(), output: Todo }),
});
```

```ts
// server.ts
import { readFileSync } from 'node:fs';
import { createApueServer, type Handlers } from 'apue/server';
import { api } from './api.ts';

const todos: Array<{ id: number; title: string; done: boolean }> = [];
const handlers: Handlers<typeof api> = {
  'todos.list': () => todos,
  'todos.create': ({ title }) => {
    const todo = { id: todos.length + 1, title, done: false };
    todos.push(todo);
    return todo;
  },
  'todos.watch': async function* (_input, ctx) {
    for (let i = ctx.resumeFrom === undefined ? 0 : Number(ctx.resumeFrom) + 1; i < todos.length; i++) {
      yield todos[i]!;
      ctx.checkpoint(String(i)); // a lost connection resumes after this item
    }
  },
};
const server = createApueServer(api, handlers, { key: readFileSync('key.pem'), cert: readFileSync('cert.pem') });
await server.listen(8443);
```

```ts
// client.ts — typed end to end, no code generation
import { ApueClient } from 'apue';
import { http2Transport } from 'apue/http2';   // browsers: fetchTransport from 'apue', or autoTransport from 'apue/websocket'
import { api } from './api.ts';

const client = new ApueClient(api, http2Transport('https://localhost:8443'));
await client.call('todos.create', { title: 'buy milk' }); // POST + Idempotency-Key: safe to retry
const all = await client.call('todos.list');              // GET /todos.list — cacheable, ETag/304
for await (const todo of client.stream('todos.watch')) console.log(todo.title);
```

### Entry points

| Import | What | Runs in |
|---|---|---|
| `apue` | `defineApi`, `op`, `t` (schemas), `ApueClient`, `fetchTransport`, `ApueError`, `Download` | browsers, Node |
| `apue/server` | `createApueServer`, `Handlers`, `CallContext`, server options, `MemoryIdempotencyStore` and the store contract | Node |
| `apue/downloads` | `download.fromFile()`, `download.fromBytes()` for `t.download()` outputs | Node |
| `apue/http2` | `http2Transport` (full duplex) | Node |
| `apue/websocket` | `webSocketTransport`, `autoTransport` (streaming uploads in every browser) | browsers |
| `apue/codegen` | `generateApi`, `generatePython`, `generateGo`, `generateJava`, `generateSwift` | Node |
| `apue-types` (CLI) | typed TypeScript modules, or Python, Go, Java and Swift clients, from a server's manifest | Node |

```sh
npx apue-types https://api.example --out api.ts              # TypeScript, imports from 'apue'
npx apue-types https://api.example --lang python --out api.py # self-contained, standard library only
npx apue-types https://api.example --lang go --out api.go     # also: --lang java, --lang swift
```

## Features

- **Operations on HTTP semantics**: `GET` with canonical `?i=` input (or `QUERY`/`POST` for large
  inputs), ETag/304, cache policies incl. CDN-Cache-Control, field selection (`?s=`), deadlines,
  idempotency keys with replay, RFC 9457 errors, deprecation headers.
- **Streams**: server, client and bidirectional; 8-byte frames with an in-band final status,
  heartbeats, SSE view; tiers for every client (HTTP/2, fetch, WebSocket with byte-window flow
  control); resumable streams with stateless signed checkpoints.
- **Binary data**: bytes as raw frames (no base64), resumable uploads
  (draft-ietf-httpbis-resumable-upload), streaming `t.file()` inputs, a persistent upload store,
  `t.download()` outputs served as short-lived links with Range/resume.
- **Batches**: dependent calls in one round trip (`$ref`), results streamed as they complete.
- **Operations**: a `principal` hook for callers and scoping, CORS, bounded shutdown, idle and body
  timeouts, a manifest with derived documentation and an RFC 9727 API catalog.

What is measured and how: [docs/benchmarks.md](docs/benchmarks.md) and
[docs/intermediaries.md](docs/intermediaries.md). What is still open: SPEC-DRAFT.md §13.

## Develop

Requires Node ≥ 26.11 (the sources run with native type stripping), `openssl` (tests generate a
throwaway certificate), Python ≥ 3.11 and Go for the generator tests (skipped if absent), Chrome,
Firefox and Playwright's WebKit (`npx playwright-core install webkit`) for the real-browser tests
(skipped if absent).

```sh
npm install
npm test                # node --test: unit, integration, fuzz, chaos, leak and real-browser tests
npm run typecheck       # tsc
npm run build           # dist/: JavaScript + declarations, as published
npm run verify:package  # npm pack → install into a fresh project → use every entry point
npm run site            # rebuild site/ from site-src/ and check links, anchors, contrast
node examples/todo/server.ts   # https://localhost:8443 — a same-origin app (self-signed cert)
node bench/run.ts       # benchmarks; bench/docker.sh, bench/proxy/run.sh need Docker
```

Releasing: [CONTRIBUTING.md](CONTRIBUTING.md#releasing). Security reports: [SECURITY.md](SECURITY.md).

## Background

- [SPEC-DRAFT.md](SPEC-DRAFT.md) — the design, what is implemented, and the spike log with every
  measurement and bug found along the way.
- [research/](research/) — problems of existing API styles, HTTP/2 and modern HTTP, data plane
  performance, Node 26, normative details, uploads, docs, callers, the remaining decisions.
- [docs/wire.md](docs/wire.md) — real curl sessions; [docs/status.md](docs/status.md) — project status.

## License

[MIT](LICENSE)
