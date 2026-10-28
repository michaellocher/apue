// apü — the web-safe core: contracts (`op`, `defineApi`), schemas (`t`), the client with its fetch
// transport, and errors. Runs in browsers, Node, Deno and Bun. Node-only parts: `@michaellocher/apue/server`,
// `@michaellocher/apue/downloads`, `@michaellocher/apue/http2`, `@michaellocher/apue/codegen`; WebSocket transports: `@michaellocher/apue/websocket`.
export { canonicalJson, defineApi, op, type Api, type CachePolicy, type Deprecation, type Effect, type InputOf, type OpDef, type OutputOf, type StreamKind } from './api.ts';
export { t, ValidationError, type DownloadRef, type DownloadSource, type FileValue, type Infer, type Issue, type Schema } from './schema.ts';
export {
  ApueClient,
  fetchTransport,
  type CallOptions,
  type ClientOptions,
  type ClientOutputOf,
  type FetchTransportOptions,
  type Transport,
  type TransportRequest,
  type TransportResponse,
  type WithDownloads,
  type WithUploadRefs,
} from './client.ts';
export { Batch, BatchCall, BatchStream } from './batch.ts';
export { Download } from './download.ts';
export { createDpopSigner, dpopHeaders, type DpopSigner } from './dpop-signer.ts';
export { ApueError, MediaType, ProblemType, type UploadRef } from './protocol.ts';
export type { EndInfo, Problem } from './frame.ts';
