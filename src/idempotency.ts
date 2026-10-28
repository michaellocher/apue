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

/**
 * Where Idempotency-Key claims and results live. The built-in MemoryIdempotencyStore is per
 * process; replicas share keys through a store implementing this contract over shared storage
 * (e.g. Redis: `SET key … NX PX` for begin) — methods may return promises for that.
 */
export interface IdempotencyStore {
  /** Atomically claims `key` for `fingerprint`, or reports why it can't be claimed. */
  begin(key: string, fingerprint: string): BeginResult | Promise<BeginResult>;
  /** Stores the final response of a claimed key. */
  complete(key: string, response: StoredResponse): void | Promise<void>;
  /** Releases a claimed key without storing (e.g. on 5xx), so a retry can execute again. */
  release(key: string): void | Promise<void>;
}

interface Entry {
  fingerprint: string;
  expiresAt: number;
  seq: number;
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
  // Insertion-ordered queue (= expiry order, constant TTL) with lazy deletion. Walking the Map
  // itself from the front is slow after many deletions (V8 keeps tombstones until rehash): a full
  // store cost ~9 µs per insert; the queue makes eviction amortised O(1).
  #queue: Array<{ key: string; seq: number }> = [];
  #head = 0;
  #seq = 0;
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
    const seq = ++this.#seq;
    this.#entries.set(key, { fingerprint, expiresAt: now + this.#ttlMs, seq });
    this.#queue.push({ key, seq });
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
    // Expired entries are at the front of the queue.
    while (this.#head < this.#queue.length) {
      const { key, seq } = this.#queue[this.#head]!;
      const entry = this.#entries.get(key);
      if (entry && entry.seq === seq) {
        if (entry.expiresAt > now) break;
        this.#entries.delete(key);
      }
      this.#head++; // expired or stale (released / re-claimed) item
    }
    if (this.#entries.size >= this.#maxEntries) {
      // Still full: drop the oldest completed entries, 1/8 of capacity at once. Never drop
      // in-progress claims, or a concurrent retry could execute twice.
      let toDrop = Math.max(1, this.#maxEntries >> 3);
      for (let i = this.#head; i < this.#queue.length && toDrop > 0; i++) {
        const { key, seq } = this.#queue[i]!;
        const entry = this.#entries.get(key);
        if (entry && entry.seq === seq && entry.response) {
          this.#entries.delete(key);
          toDrop--;
        }
      }
    }
    if (this.#head > 1024 && this.#head * 2 > this.#queue.length) {
      this.#queue = this.#queue.slice(this.#head);
      this.#head = 0;
    }
  }
}
