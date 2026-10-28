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
