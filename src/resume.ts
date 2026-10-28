// Resume tokens for streams (SPEC-DRAFT §8): self-contained and HMAC-signed, so any server replica
// that shares the secret can resume a stream — no sticky sessions, no server-side stream state.
// Node-only.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApueError, ProblemType } from './protocol.ts';

interface Payload {
  /** op name */
  o: string;
  /** hash of the canonical input: a token only resumes the same call */
  h: string;
  /** handler-defined cursor */
  c: string;
  /** expiry, epoch seconds */
  e: number;
}

export interface ResumeOptions {
  /** HMAC secret shared by all replicas. Default: random per process (single-instance only). */
  secret?: string | Uint8Array;
  /** Token lifetime. Default 15 minutes. */
  ttlMs?: number;
  now?: () => number;
}

export class ResumeTokens {
  #secret: Uint8Array;
  #ttlMs: number;
  #now: () => number;

  constructor(options: ResumeOptions = {}) {
    this.#secret = typeof options.secret === 'string' ? Buffer.from(options.secret) : (options.secret ?? randomBytes(32));
    if (this.#secret.byteLength < 16) throw new Error('resume secret must be at least 16 bytes');
    this.#ttlMs = options.ttlMs ?? 15 * 60 * 1000;
    this.#now = options.now ?? Date.now;
  }

  issue(op: string, inputHash: string, cursor: string): string {
    const payload: Payload = { o: op, h: inputHash, c: cursor, e: Math.ceil((this.#now() + this.#ttlMs) / 1000) };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.#sign(body)}`;
  }

  /** Returns the cursor, or throws 400 invalid-resume-token. */
  verify(token: string, op: string, inputHash: string): string {
    const invalid = (detail: string) => new ApueError(400, 'Invalid Resume Token', detail, { type: ProblemType.INVALID_RESUME_TOKEN });
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined) throw invalid('malformed token');
    const expected = Buffer.from(this.#sign(body), 'base64url');
    const actual = Buffer.from(signature, 'base64url');
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) throw invalid('bad signature');
    let payload: Payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    } catch {
      throw invalid('malformed token');
    }
    if (payload.o !== op || payload.h !== inputHash) throw invalid('token belongs to a different call');
    if (typeof payload.e !== 'number' || payload.e * 1000 < this.#now()) throw invalid('token expired');
    if (typeof payload.c !== 'string') throw invalid('malformed token');
    return payload.c;
  }

  #sign(body: string): string {
    return createHmac('sha256', this.#secret).update(body).digest('base64url');
  }
}
