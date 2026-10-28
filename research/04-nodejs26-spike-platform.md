# Node.js 26 as the spike platform (as of 2026-10-28)

Local: **Node v26.12.1** (latest), undici 8.12.2, nghttp2 1.70.0, OpenSSL 3.5.9, amaro 1.1.11. TypeScript 7.0.2, @types/node 26.6.5.
Legend: **[tested]** run on 26.12.1 · **[docs]** official docs/source · **[inferred]**.

## 1. Native TypeScript (https://nodejs.org/api/typescript.html)

- Type stripping **on by default and Stable** since v24.12 / v25.2 [docs]; no warning; `process.features.typescript === 'strip'` [tested].
- **`--experimental-transform-types` removed in v26.0.0** [docs, tested] → no flag enables enums etc.
- `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`: `enum`, runtime `namespace`, parameter properties, `import x = require()`, `<T>x` assertions [tested]. Decorators and `.tsx` → SyntaxError [tested].
- **Import specifiers need `.ts` extension** (`./b.ts`); `./b` and `./b.js` fail [tested].
- **Type-only imports must use `type`** (`import type {…}` / `import { type X, y }`), else runtime "does not provide an export named" [tested].
- `.ts` follows package.json `"type"`; `.mts` ESM, `.cts` CJS [tested].
- tsconfig ignored at runtime → no `paths`; use package.json `"imports"` (`#…`) [docs].
- TS in `node_modules` refused [tested]. Types replaced by whitespace → stack traces line up, no source maps needed [docs].
- `node --test` auto-discovers `test/*.test.ts`; globs work; `--watch`, `--env-file(-if-exists)`, `--run`, `process.loadEnvFile()` work [tested].
- **@types/node 26.6.5 quirk:** `server.on('stream', (stream) => …)` types `stream` as `Http2Stream` → annotate `stream: http2.ServerHttp2Stream` [tested].

## 2. node:http2 server (https://nodejs.org/api/http2.html)

- Core API: `server.on('stream', (stream, headers))`, `stream.respond()`, `for await (const c of stream)`. Compat API: `server.on('request', (req, res))` — works for h1 + h2.
- `createSecureServer({ key, cert, allowHTTP1: true })` for TLS; `createServer()` for h2c.
- Trailers: core `respond(h, { waitForTrailers: true })` + `on('wantTrailers', () => stream.sendTrailers({...}))`; compat `res.addTrailers()`. Must call `sendTrailers()`/`close()` when waiting [tested].
- **Don't mix `'stream'` and `'request'` listeners on one server** → `ERR_HTTP2_TRAILERS_ALREADY_SENT`. With `allowHTTP1`, h1 requests only reach `'request'`; a `'stream'`-only server hangs h1 clients [tested]. → Use compat API if h1 fallback is needed.
- **Full-duplex** (write response while reading request) works over h2 [tested].
- Defaults: `maxConcurrentStreams` 2³²−1; `peerMaxConcurrentStreams` 100; `maxSessionMemory` 10 MB; `streamResetBurst/Rate` 1000/33 [docs].
- v22→v26: stream priority deprecated (no-op since v24.2); raw header arrays (v24); `Symbol.asyncDispose` stable; `http1Options` (v25.7); **`connectionWindowSize` (v26.11)** [docs].

## 3. Clients

- **Global fetch negotiates h2 via ALPN by default** (undici v8 `allowH2: true`) [tested].
- Self-signed: `NODE_EXTRA_CA_CERTS=cert.pem` works for fetch and `http2.connect` [tested].
- Streaming request body: `fetch(url, { method: 'POST', body: readableStream, duplex: 'half' })` [tested].
- **h2c not possible with built-in fetch** [tested]; needs npm `undici` (`new Client(origin, { h2Options: { useH2c: true } })`).
- fetch `Response` has **no trailers** [tested]; `undici.request()` and `node:http2` client do.
- **`node:http2` client = zero-dependency route** for h2c, trailers and full duplex:

```ts
const client = http2.connect('http://localhost:8080');
const req = client.request({ ':method': 'POST', ':path': '/' });
req.on('response', h => console.log(h[':status']));
req.on('trailers', t => console.log(t));
req.end('abc'); req.setEncoding('utf8'); for await (const c of req) console.log(c);
client.close();
```

## 4. Other built-ins [tested]

Global `URLPattern`, `WebSocket`, `structuredClone`, `crypto.subtle`, `CompressionStream`, Web Streams. `EventSource` still behind `--experimental-eventsource`. `node:sqlite` RC (SQLite 3.54.0). `util.parseArgs`. `node:test` + `node:assert/strict` with `.ts`. Permission model stable; `--allow-net` experimental.

## 5. TLS for local h2

```sh
mkcert -install && mkcert -key-file certs/key.pem -cert-file certs/cert.pem localhost 127.0.0.1 ::1
# or
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 365 \
  -keyout certs/key.pem -out certs/cert.pem -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

mkcert is installed at `/opt/homebrew/bin/mkcert`. Browsers never speak h2c → browser tests need `createSecureServer` + trusted cert; h2c only for Node↔Node / `curl --http2-prior-knowledge`.

## Recommended skeleton

```json
{
  "name": "proto-spike", "private": true, "type": "module",
  "engines": { "node": ">=26.0.0" },
  "imports": { "#lib/*": "./src/lib/*" },
  "scripts": {
    "dev": "node --watch --env-file-if-exists=.env src/server.ts",
    "test": "node --test",
    "typecheck": "tsc",
    "certs": "mkcert -key-file certs/key.pem -cert-file certs/cert.pem localhost 127.0.0.1 ::1"
  },
  "devDependencies": { "typescript": "^7.0.2", "@types/node": "^26.6.5" }
}
```

```json
{
  "compilerOptions": {
    "target": "esnext", "module": "nodenext", "lib": ["esnext"], "types": ["node"],
    "noEmit": true, "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true, "verbatimModuleSyntax": true,
    "strict": true, "skipLibCheck": true
  },
  "include": ["src", "test"]
}
```

Unconfirmed: exact Node 26 LTS promotion date.
