// Benchmark API shared by bench server and client.
import { defineApi, op } from '../src/api.ts';
import { t } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';

export const Item = t.object({ i: t.number(), name: t.string(), ok: t.boolean() });
export const User = t.object({
  id: t.string(),
  name: t.string(),
  email: t.string(),
  tags: t.array(t.string()),
  total: t.number(),
  address: t.object({ street: t.string(), city: t.string(), zip: t.string() }),
});

export const benchApi = defineApi({
  'users.get': op({ effect: 'safe', input: t.object({ id: t.string() }), output: User }),
  'users.update': op({ effect: 'unsafe', input: t.object({ id: t.string(), name: t.string() }), output: User }),
  'items.stream': op({ effect: 'safe', stream: 'server', input: t.object({ n: t.number() }), output: Item }),
  'blob.get': op({ effect: 'safe', input: t.object({ kb: t.number() }), output: t.object({ data: t.string() }) }),
  'chain.step': op({ effect: 'safe', input: t.object({ n: t.number() }), output: t.object({ n: t.number() }) }),
});

export function user(id: string) {
  return {
    id,
    name: `customer ${id}`,
    email: `${id}@example.com`,
    tags: ['a', 'b', 'c'],
    total: 1234.56,
    address: { street: 'Main St 1', city: 'Berlin', zip: '10115' },
  };
}

const blobs = new Map<number, string>();
export function blob(kb: number): string {
  let value = blobs.get(kb);
  if (!value) {
    // Semi-realistic JSON-ish text (compressible, but not trivially).
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
    let text = '';
    for (let i = 0; text.length < kb * 1024; i++) text += `${words[(i * 7) % 8]}-${(i * 2654435761) % 100000} `;
    value = text.slice(0, kb * 1024);
    blobs.set(kb, value);
  }
  return value;
}

export const benchHandlers: Handlers<typeof benchApi> = {
  'users.get': ({ id }) => user(id),
  'users.update': ({ id, name }) => ({ ...user(id), name }),
  'items.stream': async function* ({ n }) {
    for (let i = 0; i < n; i++) yield { i, name: 'item', ok: true };
  },
  'blob.get': ({ kb }) => ({ data: blob(kb) }),
  'chain.step': ({ n }) => ({ n: n + 1 }),
};
