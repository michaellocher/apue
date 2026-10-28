import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalJson, defineApi, op, readPath } from '../src/api.ts';
import { t, ValidationError, type Infer } from '../src/schema.ts';

const User = t.object({
  id: t.string({ min: 1, max: 36 }),
  age: t.optional(t.number({ int: true, min: 0 })),
  role: t.enum(['admin', 'member']),
  tags: t.array(t.string(), { max: 3 }),
  manager: t.nullable(t.object({ id: t.string() })),
});
type User = Infer<typeof User>;

// Type-level assertions (checked by `npm run typecheck`).
function typeChecks(user: User): void {
  const id: string = user.id;
  const age: number | undefined = user.age;
  const role: 'admin' | 'member' = user.role;
  const managerId: string | undefined = user.manager?.id;
  // @ts-expect-error role is a closed union
  const wrong: User['role'] = 'owner';
  // @ts-expect-error id is required
  const missing: User = { role: 'admin', tags: [], manager: null };
  void [id, age, role, managerId, wrong, missing];
}
void typeChecks;

describe('schema', () => {
  test('parses valid input and drops unknown keys', () => {
    const value = User.parse({ id: 'u1', role: 'admin', tags: ['a'], manager: null, password: 'secret' });
    assert.deepEqual(value, { id: 'u1', role: 'admin', tags: ['a'], manager: null });
  });

  test('collects all issues with paths', () => {
    let error: unknown;
    try {
      User.parse({ id: '', age: 1.5, role: 'owner', tags: ['a', 7], manager: { id: 3 } });
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof ValidationError);
    assert.deepEqual(error.issues, [
      { path: 'id', message: 'shorter than 1' },
      { path: 'age', message: 'expected integer' },
      { path: 'role', message: 'expected one of admin, member' },
      { path: 'tags[1]', message: 'expected string, got number' },
      { path: 'manager.id', message: 'expected string, got number' },
    ]);
  });

  test('required, max items, numbers', () => {
    assert.throws(() => User.parse({ role: 'admin', tags: [], manager: null }), /id: required/);
    assert.throws(() => User.parse({ id: 'x', role: 'admin', tags: ['1', '2', '3', '4'], manager: null }), /more than 3 items/);
    assert.throws(() => t.number().parse(Number.NaN), /expected number/);
    assert.throws(() => t.number().parse('1'), /expected number, got string/);
    assert.throws(() => t.object({}).parse([]), /expected object, got array/);
    assert.throws(() => t.object({}).parse(null), /expected object, got null/);
    assert.equal(t.void().parse(undefined), undefined);
    assert.throws(() => t.void().parse(1), /expected no value/);
    assert.throws(() => t.string({ pattern: /^a/ }).parse('b'), /does not match/);
    // review finding: stateful flags would make repeated checks alternate; other flags are kept
    assert.throws(() => t.string({ pattern: /a/g }), /g or y flag/);
    assert.throws(() => t.string({ pattern: /a/y }), /g or y flag/);
    const caseless = t.string({ pattern: /^abc$/i });
    for (let i = 0; i < 3; i++) assert.equal(caseless.parse('ABC'), 'ABC');
    assert.deepEqual(caseless.toJSONSchema(), { type: 'string', pattern: '^abc$', 'x-apue-flags': 'i' });
    assert.deepEqual(t.string({ pattern: /^a/ }).toJSONSchema(), { type: 'string', pattern: '^a' });
  });

  test('exports JSON Schema', () => {
    assert.deepEqual(User.toJSONSchema(), {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 36 },
        age: { type: 'integer', minimum: 0 },
        role: { type: 'string', enum: ['admin', 'member'] },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
        manager: { anyOf: [{ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, { type: 'null' }] },
      },
      required: ['id', 'role', 'tags', 'manager'],
    });
  });

  test('defineApi rejects invalid op names', () => {
    const def = op({ effect: 'safe', input: t.void(), output: t.void() });
    assert.throws(() => defineApi({ 'bad name': def }), /invalid op name/);
    assert.throws(() => defineApi({ '.x': def }), /invalid op name/);
    assert.doesNotThrow(() => defineApi({ 'users.get': def, 'a.b-c.d_e': def }));
  });
});

describe('canonical JSON (RFC 8785 JCS)', () => {
  test('RFC 8785 §3.2.2 example', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    );
    assert.equal(
      canonicalJson(input),
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  test('RFC 8785 §3.2.3 property sorting by UTF-16 code units', () => {
    const input = { '€': 'Euro Sign', '\r': 'Carriage Return', 'דּ': 'Hebrew Letter Dalet With Dagesh', '1': 'One', '😀': 'Emoji: Grinning Face', '\u0080': 'Control', 'ö': 'Latin Small Letter O With Diaeresis' };
    // Compare serialised text: JS objects always enumerate integer-like keys ("1") first.
    const expected = ['\r', '1', '\u0080', 'ö', '€', '😀', 'דּ'] as const;
    assert.equal(canonicalJson(input), `{${expected.map((k) => `${JSON.stringify(k)}:${JSON.stringify(input[k])}`).join(',')}}`);
  });

  test('nested objects, undefined members, toJSON', () => {
    assert.equal(canonicalJson({ b: { d: 1, c: [3, { z: 1, y: 2 }] }, a: undefined, e: new Date(0) }), '{"b":{"c":[3,{"y":2,"z":1}],"d":1},"e":"1970-01-01T00:00:00.000Z"}');
    assert.equal(canonicalJson([undefined]), '[null]');
    assert.throws(() => canonicalJson(undefined), TypeError);
  });

  test('equal values give equal GET URLs regardless of key order', () => {
    assert.equal(readPath('users.search', { q: 'ä b', tags: ['x'] }), readPath('users.search', { tags: ['x'], q: 'ä b' }));
    assert.equal(readPath('users.search', { q: 'ä b' }), '/users.search?i=%7B%22q%22%3A%22%C3%A4%20b%22%7D');
    assert.equal(readPath('ping', undefined), '/ping');
  });
});
