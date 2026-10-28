import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MemoryIdempotencyStore } from '../src/idempotency.ts';

const response = (n: number) => ({ status: 200, headers: {}, body: new Uint8Array([n]) });

describe('MemoryIdempotencyStore', () => {
  test('new → in-progress → replay; different fingerprint → mismatch', () => {
    const store = new MemoryIdempotencyStore();
    assert.deepEqual(store.begin('k', 'f1'), { state: 'new' });
    assert.deepEqual(store.begin('k', 'f1'), { state: 'in-progress' });
    assert.deepEqual(store.begin('k', 'f2'), { state: 'mismatch' });
    store.complete('k', response(1));
    assert.deepEqual(store.begin('k', 'f1'), { state: 'replay', response: response(1) });
    assert.deepEqual(store.begin('k', 'f2'), { state: 'mismatch' });
  });

  test('release allows re-execution', () => {
    const store = new MemoryIdempotencyStore();
    store.begin('k', 'f');
    store.release('k');
    assert.deepEqual(store.begin('k', 'f'), { state: 'new' });
  });

  test('entries expire after ttl', () => {
    let now = 0;
    const store = new MemoryIdempotencyStore({ ttlMs: 1000, now: () => now });
    store.begin('k', 'f');
    store.complete('k', response(1));
    now = 999;
    assert.equal(store.begin('k', 'f').state, 'replay');
    now = 1000;
    assert.equal(store.begin('k', 'other').state, 'new');
  });

  test('eviction drops oldest completed entries but never in-progress claims', () => {
    const store = new MemoryIdempotencyStore({ maxEntries: 3 });
    store.begin('pending', 'f');
    store.begin('done1', 'f');
    store.complete('done1', response(1));
    store.begin('done2', 'f');
    store.complete('done2', response(2));
    store.begin('new', 'f'); // full → evicts done1
    assert.equal(store.size, 3);
    assert.equal(store.begin('pending', 'f').state, 'in-progress');
    assert.equal(store.begin('done2', 'f').state, 'replay');
    assert.equal(store.begin('done1', 'f').state, 'new');
  });

  test('a full store stays fast (amortised eviction)', () => {
    const store = new MemoryIdempotencyStore({ maxEntries: 10_000 });
    const started = performance.now();
    for (let i = 0; i < 200_000; i++) {
      store.begin(`k${i}`, 'f');
      store.complete(`k${i}`, response(1));
    }
    const elapsed = performance.now() - started;
    assert.ok(store.size <= 10_000);
    assert.ok(elapsed < 1_000, `200k inserts into a full store took ${elapsed.toFixed(0)} ms`);
  });
});
