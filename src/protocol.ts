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

export class ApueError extends Error {
  readonly status: number;
  readonly problem: Problem;

  constructor(status: number, title: string, detail?: string, extensions: Record<string, unknown> = {}) {
    super(detail ? `${title}: ${detail}` : title);
    this.name = 'ApueError';
    this.status = status;
    this.problem = { ...extensions, title, status, ...(detail === undefined ? {} : { detail }) };
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
