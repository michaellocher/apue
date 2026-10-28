// Idempotency-Key support (SPEC-DRAFT §5; draft-ietf-httpapi-idempotency-key-header).
// The first request with a key executes; retries with the same key and the same payload get the
// stored response replayed, so a retried POST never runs twice.

export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export type BeginResult =
  | { state: 'new' }
  | { state: 'replay'; response: StoredResponse }
  | { state: 'in-progress' }
  | { state: 'mismatch' };

export interface IdempotencyStore {
  /** Atomically claims `key` for `fingerprint`, or reports why it can't be claimed. */
  begin(key: string, fingerprint: string): BeginResult;
  /** Stores the final response of a claimed key. */
  complete(key: string, response: StoredResponse): void;
  /** Releases a claimed key without storing (e.g. on 5xx), so a retry can execute again. */
  release(key: string): void;
}

interface Entry {
  fingerprint: string;
  expiresAt: number;
  response?: StoredResponse;
}

export interface MemoryStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/** Single-process store. Multi-replica deployments need a shared store with the same contract. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  #entries = new Map<string, Entry>();
  #ttlMs: number;
  #maxEntries: number;
  #now: () => number;

  constructor(options: MemoryStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.#maxEntries = options.maxEntries ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  begin(key: string, fingerprint: string): BeginResult {
    const now = this.#now();
    const entry = this.#entries.get(key);
    if (entry && entry.expiresAt > now) {
      if (entry.fingerprint !== fingerprint) return { state: 'mismatch' };
      return entry.response ? { state: 'replay', response: entry.response } : { state: 'in-progress' };
    }
    this.#entries.delete(key);
    this.#evict(now);
    this.#entries.set(key, { fingerprint, expiresAt: now + this.#ttlMs });
    return { state: 'new' };
  }

  complete(key: string, response: StoredResponse): void {
    const entry = this.#entries.get(key);
    if (entry) entry.response = response;
  }

  release(key: string): void {
    this.#entries.delete(key);
  }

  #evict(now: number): void {
    if (this.#entries.size < this.#maxEntries) return;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
    // Still full: drop oldest completed entries (Map iterates in insertion order). Never drop
    // in-progress claims, or a concurrent retry could execute twice.
    for (const [key, entry] of this.#entries) {
      if (this.#entries.size < this.#maxEntries) break;
      if (entry.response) this.#entries.delete(key);
    }
  }
}
