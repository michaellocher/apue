// Shared protocol constants and the error type (SPEC-DRAFT §5, §7). Web-platform only.
import type { Problem } from './frame.ts';

export const MediaType = {
  JSON: 'application/json',
  PROBLEM: 'application/problem+json',
  STREAM_JSON: 'application/apue+json',
  SSE: 'text/event-stream',
} as const;

export const Header = {
  TIMEOUT: 'apue-timeout',
  RESUME: 'apue-resume',
  /** The replica holding the uploads a call references (server option `instance`): a load-balancer routing hint. */
  REPLICA: 'apue-replica',
} as const;

/**
 * The replica that holds every upload referenced in `input` (ids `<instance>.<random>`), or
 * undefined when there are none, they are unprefixed, or they live on different replicas.
 */
export function replicaOf(input: unknown): string | undefined {
  let replica: string | undefined;
  let mixed = false;
  const visit = (value: unknown): void => {
    if (mixed || value === null || typeof value !== 'object' || value instanceof Uint8Array) return;
    if (isUploadRef(value)) {
      const dot = value.$upload.indexOf('.');
      const prefix = dot > 0 ? value.$upload.slice(0, dot) : undefined;
      if (prefix === undefined || (replica !== undefined && replica !== prefix)) mixed = true;
      else replica = prefix;
      return;
    }
    for (const item of Array.isArray(value) ? value : Object.values(value)) visit(item);
  };
  visit(input);
  return mixed ? undefined : replica;
}

/**
 * Problem type URIs for apü-specific errors (RFC 9457 §3.1.1). Generic errors use the default
 * type about:blank with the HTTP status phrase as title (§4.2.1).
 * NOTE: https://apue.dev is a placeholder namespace until the spec has a home.
 */
export const ProblemType = {
  VALIDATION: 'https://apue.dev/problems/validation-failed',
  UNKNOWN_OPERATION: 'https://apue.dev/problems/unknown-operation',
  TRUNCATED_STREAM: 'https://apue.dev/problems/truncated-stream',
  DEADLINE: 'https://apue.dev/problems/deadline-exceeded',
  IDEMPOTENCY_IN_PROGRESS: 'https://apue.dev/problems/idempotency-key-in-progress',
  IDEMPOTENCY_MISMATCH: 'https://apue.dev/problems/idempotency-key-reused',
  /** An Idempotency-Key replay whose t.download() URL has expired: the operation is not run again. */
  DOWNLOAD_EXPIRED: 'https://apue.dev/problems/download-expired',
  FAILED_DEPENDENCY: 'https://apue.dev/problems/failed-dependency',
  UNRESOLVABLE_REFERENCE: 'https://apue.dev/problems/unresolvable-reference',
  INVALID_BATCH: 'https://apue.dev/problems/invalid-batch',
  MALFORMED_STREAM: 'https://apue.dev/problems/malformed-stream',
  INVALID_RESUME_TOKEN: 'https://apue.dev/problems/invalid-resume-token',
  INVALID_SELECTION: 'https://apue.dev/problems/invalid-selection',
} as const;

export class ApueError extends Error {
  readonly status: number;
  readonly problem: Problem;
  /** Extra response header fields (e.g. `allow` on 405). */
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    title: string,
    detail?: string,
    extensions: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    super(detail ? `${title}: ${detail}` : title);
    this.name = 'ApueError';
    this.status = status;
    this.problem = { ...extensions, title, status, ...(detail === undefined ? {} : { detail }) };
    this.headers = headers;
  }

  static fromProblem(problem: Partial<Problem> | undefined, fallbackStatus: number): ApueError {
    const { title = 'Error', status = fallbackStatus, detail, ...rest } = problem ?? {};
    return new ApueError(status, title, detail, rest);
  }
}

export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value != null && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function';
}

export function baseMediaType(contentType: string | null | undefined): string {
  return (contentType ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

// WebSocket tier (T3, SPEC-DRAFT §8): subprotocol and flow-control rules, shared by the Node server
// (websocket.ts) and the web client (transport-ws.ts) so the two can't drift apart.
export const WS_SUBPROTOCOL = 'apue.v1';
/**
 * Browsers can't set WebSocket headers, only subprotocols: an `Authorization` value travels as one
 * more offered subprotocol, `apue.auth.<base64url without padding>` (the Kubernetes pattern). The
 * server never selects (echoes) it and hands it to the call as the `authorization` header.
 */
export const WS_AUTH_PREFIX = 'apue.auth.';
/**
 * A proof of possession for the call (a `DPoP` header value: a compact JWS, which consists of token
 * characters already) travels unencoded as `apue.dpop.<value>`; handed to the call as `dpop`.
 */
export const WS_DPOP_PREFIX = 'apue.dpop.';
/** Values that can travel as a subprotocol token unencoded (base64url segments joined by dots). */
export const WS_TOKEN_VALUE = /^[A-Za-z0-9_.-]+$/;

/** `Authorization` value → offered subprotocol (base64url: token characters only, RFC 6455 §4.1). */
export function wsAuthProtocol(authorization: string): string {
  const bytes = new TextEncoder().encode(authorization);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return WS_AUTH_PREFIX + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Offered subprotocol → `Authorization` value; undefined unless it is canonical base64url without
 * padding of a valid field value (visible ASCII, spaces and tabs inside: RFC 9110 §5.5), so nothing
 * a header could not carry (CR, LF, NUL) reaches the call this way.
 */
export function parseWsAuthProtocol(protocol: string): string | undefined {
  const encoded = protocol.slice(WS_AUTH_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) return undefined;
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  if (wsAuthProtocol(binary) !== protocol) return undefined; // non-canonical (stray low bits)
  return /^[\x21-\x7e](?:[\x20-\x7e\t]*[\x21-\x7e])?$/.test(binary) ? binary : undefined;
}
/** Window each side may use before the peer's first credit (HTTP/2's default is 65,535). */
export const WS_INITIAL_WINDOW = 64 * 1024;
/** Upper bound of a window and of one increment (HTTP/2: 2^31 - 1). */
export const WS_MAX_WINDOW = 2 ** 31 - 1;

/** Parses a credit text message: a decimal increment in 1..2^31-1, no sign, no leading zeros. */
export function parseCredit(text: string): number | undefined {
  if (!/^[1-9]\d{0,9}$/.test(text)) return undefined;
  const n = Number(text);
  return n <= WS_MAX_WINDOW ? n : undefined;
}

/** A configured window must be an integer in [WS_INITIAL_WINDOW, WS_MAX_WINDOW] (credits are integers). */
export function checkWindow(name: string, value: number): number {
  if (!Number.isInteger(value) || value < WS_INITIAL_WINDOW || value > WS_MAX_WINDOW) {
    throw new RangeError(`${name} must be an integer from ${WS_INITIAL_WINDOW} to 2^31-1, got ${value}`);
  }
  return value;
}

/**
 * Errors Node raises when the peer resets or drops a stream/session (or an operation was aborted
 * via the call's signal): the client is gone — reported as 499, never logged as a server failure.
 */
const CLIENT_GONE_CODES = new Set([
  'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED', 'ERR_HTTP2_STREAM_ERROR', 'ERR_HTTP2_STREAM_CANCEL',
  'ERR_HTTP2_INVALID_SESSION', 'ERR_HTTP2_SESSION_ERROR', 'ERR_HTTP2_GOAWAY_SESSION',
  'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ABORT_ERR',
]);

export function isClientGone(error: unknown): boolean {
  return typeof error === 'object' && error !== null && CLIENT_GONE_CODES.has(String((error as { code?: unknown }).code));
}

// Resumable uploads (SPEC-DRAFT §6, research/06): shared by server (uploads.ts) and client.
export const UPLOADS_PATH = '/$uploads';
/** Download resources for t.download() outputs (src/downloads.ts). */
export const DOWNLOADS_PATH = '/$downloads';
/** draft-ietf-httpbis-resumable-upload-14, Appendix B. */
export const UPLOAD_INTEROP_VERSION = '10';

/** What a t.bytes() input carries instead of the bytes once they are uploaded. */
export interface UploadRef {
  $upload: string;
}

/** `{ "$upload": "<id>" }` and nothing else. */
export function isUploadRef(value: unknown): value is UploadRef {
  return typeof value === 'object' && value !== null && !(value instanceof Uint8Array) && typeof (value as UploadRef).$upload === 'string' && Object.keys(value).length === 1;
}
