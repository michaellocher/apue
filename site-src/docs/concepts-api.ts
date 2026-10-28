import { defineApi, op, t, type Infer } from '../../src/index.ts';

export const User = t.object({
  id: t.string(),
  name: t.string({ min: 1, max: 100 }),
  email: t.optional(t.string({ pattern: /^[^@\s]+@[^@\s]+$/ })),
  address: t.nullable(t.object({
    city: t.string(),
    country: t.string({ min: 2, max: 2 }),
  })),
  roles: t.array(t.enum(['admin', 'member']), { max: 8 }),
});
export type User = Infer<typeof User>; // { id: string; name: string; email?: string; … }

export const api = defineApi({
  'users.get': op({
    effect: 'safe',                    // GET (or QUERY), cacheable, retried
    description: 'One user by id.',
    input: t.object({ id: t.string() }),
    output: User,
    cache: { maxAge: 60, staleWhileRevalidate: 300 },
  }),
  'users.rename': op({
    effect: 'idempotent',              // POST + Idempotency-Key, retried
    input: t.object({ id: t.string(), name: t.string({ min: 1, max: 100 }) }),
    output: User,
  }),
  'users.invite': op({
    effect: 'unsafe',                  // POST + Idempotency-Key: retries are safe thanks to the key
    input: t.object({ email: t.string() }),
    output: t.object({ id: t.string() }),
  }),
  'users.search': op({
    effect: 'safe',
    input: t.object({ name: t.string() }),
    output: t.array(User, { max: 50 }), // limits are part of the contract
    deprecated: {
      since: new Date('2026-10-01T00:00:00Z'),
      sunset: new Date('2027-04-01T00:00:00Z'),
      link: 'https://example.com/migrate',
    },
  }),
});
