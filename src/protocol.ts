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
} as const;

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
