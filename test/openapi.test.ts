// OpenAPI 3.2 description derived from the op definitions (src/openapi.ts): its structure per op
// kind, validity against the official OAS 3.2 JSON Schemas (vendored in test/fixtures/openapi-3.2,
// see sources.json; validated with the test-only validator in json-schema.ts), and how the server
// serves it — lazily, with ETag/304, linked from the RFC 9727 catalog, and switched off on request.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { defineApi, deprecationHeaders, op, type Api } from '../src/api.ts';
import { opErrors, opHttp, PROTOCOL_ERRORS } from '../src/docs.ts';
import { download } from '../src/downloads.ts';
import { buildOpenApi, JSON_SCHEMA_DIALECT, OPENAPI_MEDIA_TYPE, type OpenApiOptions } from '../src/openapi.ts';
import { MediaType, ProblemType } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import { CATALOG_PATH, MANIFEST_PATH, OPENAPI_PATH, type Handlers } from '../src/server.ts';
import { SchemaRegistry } from './json-schema.ts';
import { startServer } from './helpers.ts';

const since = new Date('2026-01-01T00:00:00Z');
const sunset = new Date('2027-01-01T00:00:00Z');
const User = t.object({ id: t.string({ pattern: /^u-\d+$/i }), name: t.string({ min: 1 }), age: t.optional(t.number({ int: true, min: 0 })) });

const api = defineApi({
  'users.get': op({ effect: 'safe', input: t.object({ id: t.string() }), output: User, cache: { maxAge: 60 }, description: 'One user' }),
  'users.list': op({ effect: 'safe', input: t.void(), output: t.array(User, { max: 10 }) }),
  'users.count': op({ effect: 'safe', input: t.void(), output: t.number() }),
  'orders.create': op({ effect: 'unsafe', input: t.object({ item: t.string() }), output: t.object({ id: t.string() }) }),
  'orders.cancel': op({ effect: 'idempotent', input: t.object({ id: t.string() }), output: t.void(), deprecated: { since, sunset, link: 'https://example.com/migrate' } }),
  'events.watch': op({ effect: 'safe', stream: 'server', resumable: true, input: t.object({ from: t.number() }), output: t.object({ seq: t.number() }) }),
  'numbers.sum': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
  'chat.talk': op({ effect: 'unsafe', stream: 'bidi', input: t.string(), output: t.string() }),
  'files.get': op({ effect: 'safe', input: t.void(), output: t.object({ name: t.string(), data: t.bytes() }) }),
  'files.put': op({ effect: 'unsafe', input: t.object({ name: t.string(), data: t.bytes(), big: t.optional(t.file({ max: 1000 })) }), output: t.void() }),
  'reports.export': op({ effect: 'idempotent', input: t.void(), output: t.download({ type: 'text/csv' }) }),
});

const handlers: Handlers<typeof api> = {
  'users.get': ({ id }) => ({ id, name: 'Ada' }),
  'users.list': () => [],
  'users.count': () => 1,
  'orders.create': ({ item }) => ({ id: `${item}-${Math.random()}` }),
  'orders.cancel': () => undefined,
  'events.watch': async function* ({ from }) {
    yield { seq: from };
  },
  'numbers.sum': async (inputs) => {
    let sum = 0;
    for await (const n of inputs) sum += n;
    return sum;
  },
  'chat.talk': async function* (inputs) {
    for await (const text of inputs) yield text;
  },
  'files.get': () => ({ name: 'a', data: new Uint8Array([1]) }),
  'files.put': () => undefined,
  'reports.export': () => download.fromBytes(new TextEncoder().encode('a,b\n'), { type: 'text/csv' }),
};

// --- the official schemas -----------------------------------------------------------------------

const FIXTURES = new URL('./fixtures/openapi-3.2/', import.meta.url);
const OAS_SCHEMA = 'https://spec.openapis.org/oas/3.2/schema/2026-08-30';
const OAS_SCHEMA_BASE = 'https://spec.openapis.org/oas/3.2/schema-base/2026-08-30';
const OAS_DIALECT = 'https://spec.openapis.org/oas/3.2/dialect/2026-02-26';
const registry = new SchemaRegistry();
for (const file of readdirSync(FIXTURES)) {
  if (file !== 'sources.json') registry.addSchema(JSON.parse(readFileSync(new URL(file, FIXTURES), 'utf8')));
}
/**
 * schema-base with the dialect our documents declare: like the official schema-base (which pins the
 * OAS dialect), every Schema Object is validated — here against the JSON Schema 2020-12 meta-schema,
 * the dialect apü emits (`jsonSchemaDialect`).
 */
const OAS_WITH_2020_12 = registry.addSchema({
  $id: 'urn:apue:test:oas-3.2-schema-2020-12',
  $ref: OAS_SCHEMA,
  $defs: { schema: { $dynamicAnchor: 'meta', $ref: 'https://json-schema.org/draft/2020-12/schema' } },
});

/** Valid against the OAS 3.2 schema, with Schema Objects checked as 2020-12 and as the OAS dialect. */
function assertValidOpenApi(doc: Record<string, any>): void {
  for (const [name, uri, value] of [
    ['OAS 3.2 schema', OAS_SCHEMA, doc],
    ['OAS 3.2 schema + 2020-12 Schema Objects', OAS_WITH_2020_12, doc],
    // The official schema-base requires jsonSchemaDialect to be the OAS dialect; our schemas are
    // valid in that dialect too (it is 2020-12 plus OAS keywords).
    ['OAS 3.2 schema-base (OAS dialect)', OAS_SCHEMA_BASE, { ...doc, jsonSchemaDialect: OAS_DIALECT }],
  ] as const) {
    const result = registry.validate(uri, value);
    assert.ok(result.valid, `${name}: ${result.errors.slice(0, 8).join('\n')}`);
  }
}

/** Every Example Object's dataValue (and every x-apue-message-example) against its schema (OAS 3.2 §4.19.1: "MUST be valid"). */
function assertExamplesValid(doc: Record<string, any>): number {
  const uri = `urn:apue:test:doc-${Math.random()}`;
  registry.addDocument(doc, uri);
  const deref = (node: any): any => (node && typeof node.$ref === 'string' && node.$ref.startsWith('#/') ? deref(pointer(doc, node.$ref)) : node);
  let checked = 0;
  const check = (schema: any, value: unknown, where: string) => {
    const result = registry.validateNode(schema, uri, value);
    assert.ok(result.valid, `${where}: ${JSON.stringify(value)} — ${result.errors.join('; ')}`);
    checked++;
  };
  const media = (mt: any, where: string) => {
    for (const [name, example] of Object.entries<any>(mt.examples ?? {})) {
      const resolved = deref(example);
      if ('dataValue' in resolved) check(mt.schema, resolved.dataValue, `${where} example ${name}`);
    }
    if ('x-apue-message-example' in mt) check(mt['x-apue-message-schema'], mt['x-apue-message-example'], `${where} message example`);
    // The extension schemas are not Schema Objects to OAS: check them against the 2020-12 meta-schema here.
    if ('x-apue-message-schema' in mt) {
      const meta = registry.validate('https://json-schema.org/draft/2020-12/schema', mt['x-apue-message-schema']);
      assert.ok(meta.valid, `${where}: x-apue-message-schema ${meta.errors.join('; ')}`);
    }
  };
  const parameter = (p: any, where: string) => {
    p = deref(p);
    const schema = p.schema ?? (Object.values<any>(p.content ?? {})[0]?.schema);
    for (const [name, example] of Object.entries<any>(p.examples ?? {})) {
      const resolved = deref(example);
      if ('dataValue' in resolved) check(schema, resolved.dataValue, `${where} parameter ${p.name} example ${name}`);
    }
    for (const [type, mt] of Object.entries<any>(p.content ?? {})) media(mt, `${where} parameter ${p.name} ${type}`);
  };
  for (const [path, item] of Object.entries<any>(doc.paths)) {
    for (const p of item.parameters ?? []) parameter(p, path);
    for (const method of ['get', 'head', 'query', 'post', 'patch', 'delete', 'options']) {
      const operation = item[method];
      if (!operation) continue;
      const where = `${method.toUpperCase()} ${path}`;
      for (const p of operation.parameters ?? []) parameter(p, where);
      for (const [type, mt] of Object.entries<any>(operation.requestBody?.content ?? {})) media(mt, `${where} request ${type}`);
      for (const [status, response] of Object.entries<any>(operation.responses)) {
        for (const [type, mt] of Object.entries<any>(deref(response).content ?? {})) media(mt, `${where} ${status} ${type}`);
      }
    }
  }
  return checked;
}

function pointer(doc: any, ref: string): any {
  return ref
    .slice(2)
    .split('/')
    .reduce((node, token) => node[token.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
}

const serverFacts: OpenApiOptions = { uploads: { maxBytes: 1024, maxAgeSeconds: 60 }, downloads: true, manifest: MANIFEST_PATH };

describe('OpenAPI 3.2 from the op definitions', () => {
  const doc = buildOpenApi(api, { title: 'Test API', version: '1.2.3', ...serverFacts });
  const ops = (name: string) => doc.paths[`/${name}`];
  const resolve = (node: any): any => (node?.$ref ? resolve(pointer(doc, node.$ref)) : node);
  const params = (name: string, method: string) => [...(ops(name).parameters ?? []), ...(ops(name)[method].parameters ?? [])].map(resolve);
  const param = (name: string, method: string, pname: string) => params(name, method).find((p) => p.name === pname);

  test('the vendored schemas are the files from sources.json, and themselves valid 2020-12', () => {
    const sources = JSON.parse(readFileSync(new URL('sources.json', FIXTURES), 'utf8'));
    for (const [file, { sha256 }] of Object.entries<any>(sources.files)) {
      const text = readFileSync(new URL(file, FIXTURES));
      assert.equal(createHash('sha256').update(text).digest('hex'), sha256, file);
      const result = registry.validate('https://json-schema.org/draft/2020-12/schema', JSON.parse(text.toString()));
      assert.ok(result.valid, `${file}: ${result.errors.join('; ')}`);
    }
  });

  test('valid against the official OpenAPI 3.2 schemas (several option combinations)', () => {
    assertValidOpenApi(doc);
    assertValidOpenApi(buildOpenApi(api));
    assertValidOpenApi(buildOpenApi(api, { idempotency: false, servers: [{ url: 'https://api.example', description: 'production' }] }));
    assertValidOpenApi(buildOpenApi(defineApi({ ping: op({ effect: 'safe', input: t.void(), output: t.void() }) })));
  });

  test('the validator is not vacuous: broken documents fail', () => {
    const broken: Array<[string, (d: any) => void]> = [
      ['openapi 3.1', (d) => (d.openapi = '3.1.1')],
      ['parameter with schema and content', (d) => (d.components.parameters['users.get.i'].schema = { type: 'string' })],
      ['content map with two entries', (d) => (d.components.parameters['users.get.i'].content['text/plain'] = {})],
      ['unknown field in a response', (d) => (d.paths['/users.get'].get.responses['200'].bogus = true)],
      ['Example Object with value and dataValue', (d) => (d.components.examples['validation-failed'].value = {})],
      ['invalid Schema Object (type)', (d) => (d.components.schemas['users.get.Input'].type = 'record')],
      ['invalid Schema Object in an itemSchema', (d) => (d.components.schemas['events.watch.Event'].required = 'event')],
      ['response code 600', (d) => (d.paths['/users.get'].get.responses['600'] = { description: 'x' })],
      ['QUERY under additionalOperations', (d) => (d.paths['/users.get'].additionalOperations = { QUERY: d.paths['/users.get'].query })],
    ];
    for (const [what, mutate] of broken) {
      const copy = structuredClone(doc);
      mutate(copy);
      assert.equal(registry.validate(OAS_WITH_2020_12, copy).valid, false, what);
    }
  });

  test('every example validates against its schema (dataValue MUST be valid)', () => {
    assert.ok(assertExamplesValid(doc) >= 20);
  });

  test('document basics: version, dialect, info, servers, tags, back-references', () => {
    assert.equal(doc.openapi, '3.2.0');
    assert.equal(doc.jsonSchemaDialect, JSON_SCHEMA_DIALECT);
    assert.equal(doc.jsonSchemaDialect, 'https://json-schema.org/draft/2020-12/schema');
    assert.deepEqual([doc.info.title, doc.info.version], ['Test API', '1.2.3']);
    assert.deepEqual(doc.servers, [{ url: '/' }]); // relative to where the document is served
    assert.deepEqual(doc.tags.map((tag: { name: string }) => tag.name), ['chat', 'events', 'files', 'numbers', 'orders', 'reports', 'users']);
    assert.equal(doc['x-apue-manifest'], MANIFEST_PATH);
    for (const name of Object.keys(api)) {
      for (const method of ['get', 'head', 'query', 'post']) {
        if (ops(name)[method]) assert.equal(ops(name)[method]['x-apue-op'], name);
      }
    }
    const ids = Object.values<any>(doc.paths).flatMap((item) => Object.values<any>(item).map((o) => o?.operationId).filter(Boolean));
    assert.equal(new Set(ids).size, ids.length, 'operationIds are unique');
  });

  test('methods as the server routes them: reads GET/HEAD/QUERY/POST, everything else POST (= opHttp)', () => {
    for (const [name, def] of Object.entries<any>(api)) {
      const methods = ['get', 'head', 'query', 'post'].filter((m) => ops(name)[m]).map((m) => m.toUpperCase());
      assert.deepEqual(methods, opHttp(name, def).methods, name);
    }
    assert.deepEqual(Object.keys(ops('users.get')).filter((k) => ['get', 'head', 'query', 'post', 'put'].includes(k)), ['get', 'head', 'query', 'post']);
    assert.equal(ops('orders.create').get, undefined);
    assert.equal(ops('events.watch').query.operationId, 'events.watch:query');
  });

  test('unary read: ?i= as a JSON content parameter, QUERY/POST bodies, ETag and 304', () => {
    const i = param('users.get', 'get', 'i');
    assert.equal(i.in, 'query');
    assert.equal(i.required, true);
    assert.equal(i.schema, undefined); // "MUST include either a content field or a schema field, but not both"
    assert.deepEqual(Object.keys(i.content), [MediaType.JSON]); // "MUST only contain one entry"
    assert.deepEqual(resolve(i.content[MediaType.JSON].schema), { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] });
    assert.deepEqual(i.examples.placeholder, {
      summary: 'Generated placeholder, validated against the schema',
      dataValue: { id: 'string' },
      serializedValue: 'i=%7B%22id%22%3A%22string%22%7D',
    });
    assert.equal(param('users.get', 'head', 'i'), i);
    assert.equal(param('users.get', 'query', 'i'), undefined);
    assert.equal(param('users.list', 'get', 'i'), undefined); // void input: nothing to send
    for (const method of ['query', 'post']) {
      const body = ops('users.get')[method].requestBody;
      assert.deepEqual(body.content[MediaType.JSON].schema, { $ref: '#/components/schemas/users.get.Input' });
      assert.equal(body.required, true);
    }
    assert.equal(ops('users.list').post.requestBody.required, false); // void accepts an empty body
    const get = ops('users.get').get.responses;
    assert.deepEqual(get['200'].content[MediaType.JSON].schema, { $ref: '#/components/schemas/users.get.Output' });
    assert.deepEqual(get['200'].headers, { ETag: { $ref: '#/components/headers/ETag' } });
    assert.ok(get['304']);
    assert.ok(param('users.get', 'get', 'If-None-Match'));
    assert.equal(ops('users.get').head.responses['200'].content, undefined); // HEAD: no content
    // apü's own keywords stay (pattern flags travel as x-apue-flags).
    assert.deepEqual(doc.components.schemas['users.get.Output'].properties.id, { type: 'string', pattern: '^u-\\d+$', 'x-apue-flags': 'i' });
  });

  test('unary write: POST with a JSON body and Idempotency-Key where honoured', () => {
    const post = ops('orders.create').post;
    assert.ok(param('orders.create', 'post', 'Idempotency-Key'));
    assert.equal(param('orders.create', 'post', 'If-None-Match'), undefined);
    assert.deepEqual(post.requestBody.content[MediaType.JSON].schema, { $ref: '#/components/schemas/orders.create.Input' });
    assert.deepEqual(post.responses['200'].headers, { 'apue-replayed': { $ref: '#/components/headers/Replayed' } });
    assert.equal(post.responses['304'], undefined);
    for (const name of ['orders.cancel', 'files.put', 'reports.export']) assert.ok(param(name, 'post', 'Idempotency-Key'), name);
    for (const name of ['users.get', 'events.watch', 'numbers.sum', 'chat.talk']) {
      for (const method of ['get', 'query', 'post']) if (ops(name)[method]) assert.equal(param(name, method, 'Idempotency-Key'), undefined, `${name} ${method}`);
    }
    // Without an idempotency store keys are not honoured: no header, no 409/422.
    const plain = buildOpenApi(api, { idempotency: false });
    const plainParams = (plain.paths['/orders.create'].post.parameters ?? []).map((p: any) => p.$ref);
    assert.ok(!plainParams.includes('#/components/parameters/IdempotencyKey'));
    assert.equal(plain.paths['/orders.create'].post.responses['409'], undefined);
    assert.equal(plain.components.parameters.IdempotencyKey, undefined);
  });

  test('every op: apue-timeout; ?s= only where the output has fields', () => {
    for (const name of Object.keys(api)) assert.ok(params(name, 'post').some((p) => p.name === 'apue-timeout'), name);
    assert.deepEqual(param('users.get', 'get', 's').examples.fields.dataValue, 'id,name');
    assert.ok(param('users.list', 'get', 's')); // arrays of objects are selectable
    assert.ok(param('events.watch', 'get', 's'));
    assert.equal(param('users.count', 'get', 's'), undefined);
    assert.equal(param('numbers.sum', 'post', 's'), undefined);
    assert.equal(param('reports.export', 'post', 's'), undefined);
  });

  test('problem responses: the protocol errors per op and method, shared Problem schema', () => {
    const statuses = (name: string, method: string) => Object.keys(ops(name)[method].responses).filter((s) => /^[45]/.test(s));
    assert.deepEqual(statuses('users.get', 'get'), ['400', '500', '504']); // no body: no 408/413/415
    assert.deepEqual(statuses('users.get', 'post'), ['400', '408', '413', '415', '500', '504']);
    assert.deepEqual(statuses('orders.create', 'post'), ['400', '408', '409', '413', '415', '422', '500', '504']);
    assert.deepEqual(statuses('numbers.sum', 'post'), ['400', '413', '415', '500', '504']);
    // Kinds per status, as examples: the common 400s plus the op's own (opErrors).
    const kinds = (name: string, method: string, status: string) => Object.keys(resolve(ops(name)[method].responses[status]).content[MediaType.PROBLEM].examples);
    assert.deepEqual(kinds('users.get', 'get', '400'), ['bad-request', 'validation-failed', 'invalid-selection']);
    assert.deepEqual(kinds('numbers.sum', 'post', '400'), ['bad-request', 'validation-failed', 'invalid-selection', 'malformed-stream', 'truncated-stream']);
    assert.deepEqual(kinds('events.watch', 'get', '400'), ['bad-request', 'validation-failed', 'invalid-selection', 'invalid-resume-token']);
    assert.deepEqual(kinds('orders.create', 'post', '409'), ['idempotency-key-in-progress']);
    // Everything PROTOCOL_ERRORS + opErrors lists is documented on POST, except what cannot answer a
    // documented method on a documented path (unknown operation, 405).
    for (const [name, def] of Object.entries<any>(api)) {
      for (const p of [...PROTOCOL_ERRORS, ...opErrors(def)]) {
        if (p.type === ProblemType.UNKNOWN_OPERATION || p.status === 405) continue;
        const response = resolve(ops(name).post.responses[String(p.status)]);
        assert.ok(response, `${name} ${p.status}`);
        const example = Object.values<any>(response.content[MediaType.PROBLEM].examples).map(resolve).find((e) => e.summary === p.title);
        assert.deepEqual(example?.dataValue, { ...(p.type === 'about:blank' ? {} : { type: p.type }), title: p.title, status: p.status }, `${name} ${p.title}`);
      }
      assert.equal(ops(name).post.responses['404'], undefined);
      assert.equal(ops(name).post.responses['405'], undefined);
      assert.deepEqual(ops(name).post.responses.default, { $ref: '#/components/responses/Error' });
    }
    const problem = doc.components.schemas.Problem;
    assert.deepEqual(Object.keys(problem.properties), ['type', 'title', 'status', 'detail', 'instance', 'retryable', 'fields']);
    assert.equal(resolve(ops('users.get').get.responses['400']).content[MediaType.PROBLEM].schema.$ref, '#/components/schemas/Problem');
  });

  test('server stream: framed (opaque, message schema as extension) and SSE with itemSchema', () => {
    const content = ops('events.watch').get.responses['200'].content;
    assert.deepEqual(Object.keys(content), [MediaType.STREAM_JSON, MediaType.SSE]);
    const framed = content[MediaType.STREAM_JSON];
    assert.equal(framed.schema, undefined);
    assert.equal(framed.itemSchema, undefined); // frames have a header: not a sequential media type for OAS
    assert.deepEqual(framed['x-apue-message-schema'], { $ref: '#/components/schemas/events.watch.Output' });
    assert.deepEqual(framed['x-apue-message-example'], { seq: 0 });
    const event = resolve(content[MediaType.SSE].itemSchema);
    assert.deepEqual(event.required, ['event', 'data']);
    assert.deepEqual(
      event.oneOf.map((branch: any) => [branch.properties.event.const, branch.properties.data.contentSchema]),
      [['msg', { $ref: '#/components/schemas/events.watch.Output' }], ['end', { $ref: '#/components/schemas/End' }]],
    );
    assert.ok(param('events.watch', 'get', 'apue-resume'));
    assert.equal(param('events.watch', 'get', 'If-None-Match'), undefined); // streams have no ETag
    assert.equal(ops('events.watch').get.responses['304'], undefined);
    assert.equal(param('users.get', 'get', 'apue-resume'), undefined);
  });

  test('client and bidi streams: framed request body', () => {
    for (const name of ['numbers.sum', 'chat.talk']) {
      const body = ops(name).post.requestBody;
      assert.equal(body.required, true);
      assert.deepEqual(Object.keys(body.content), [MediaType.STREAM_JSON]);
      assert.deepEqual(body.content[MediaType.STREAM_JSON]['x-apue-message-schema'], { $ref: `#/components/schemas/${name}.Input` });
    }
    assert.deepEqual(Object.keys(ops('numbers.sum').post.responses['200'].content), [MediaType.JSON]);
    assert.deepEqual(Object.keys(ops('chat.talk').post.responses['200'].content), [MediaType.STREAM_JSON, MediaType.SSE]);
  });

  test('bytes: upload references in unary inputs, BLOB references in frames; framed unary output', () => {
    const input = doc.components.schemas['files.put.Input'];
    assert.deepEqual(input.properties.data, { $ref: '#/components/schemas/UploadReference', 'x-apue-transfer': 'upload' });
    assert.deepEqual(input.properties.big, { $ref: '#/components/schemas/UploadReference', 'x-apue-max-size': 1000, 'x-apue-transfer': 'upload' });
    assert.deepEqual(doc.components.schemas.UploadReference.required, ['$upload']);
    assert.deepEqual(ops('files.put').post.requestBody.content[MediaType.JSON].examples.placeholder.dataValue, { name: 'string', data: { $upload: '<upload id>' }, big: { $upload: '<upload id>' } });
    const content = ops('files.get').get.responses['200'].content;
    assert.deepEqual(Object.keys(content), [MediaType.STREAM_JSON]); // unary output with bytes: framed
    assert.deepEqual(doc.components.schemas['files.get.Output'].properties.data, { $ref: '#/components/schemas/BlobReference', 'x-apue-transfer': 'blob-frames' });
    assert.ok(ops('files.get').get.responses['304']); // still a cacheable read
  });

  test('t.download(): the reference schema; /$downloads and /$uploads only when served', () => {
    const output = doc.components.schemas['reports.export.Output'];
    assert.deepEqual(output, { $ref: '#/components/schemas/DownloadReference', 'x-apue-transfer': 'download', contentMediaType: 'text/csv' });
    assert.deepEqual(doc.components.schemas.DownloadReference.required, ['$download', 'size', 'type', 'expires']);
    assert.deepEqual(Object.keys(doc.paths['/$downloads/{id}']).filter((k) => k !== 'parameters' && k !== 'description'), ['get', 'head']);
    assert.ok(doc.paths['/$downloads/{id}'].get.responses['206']);
    assert.ok(doc.paths['/$uploads'].post.responses['201']);
    assert.deepEqual(Object.keys(doc.paths['/$uploads/{id}']).filter((k) => k !== 'parameters'), ['head', 'get', 'patch', 'delete']);
    assert.match(doc.paths['/$uploads'].description, /at most 1024 bytes per upload, kept 60 s/);
    const bare = buildOpenApi(api);
    assert.equal(bare.paths['/$uploads'], undefined);
    assert.equal(bare.paths['/$downloads/{id}'], undefined);
  });

  test('deprecated: flag and the exact Deprecation/Sunset/Link headers on every response', () => {
    const post = ops('orders.cancel').post;
    assert.equal(post.deprecated, true);
    assert.equal(ops('orders.create').post.deprecated, undefined);
    const expected = deprecationHeaders({ since, sunset, link: 'https://example.com/migrate' });
    for (const [status, response] of Object.entries<any>(post.responses)) {
      if (status === 'default') continue;
      const headers = Object.fromEntries(
        Object.entries<any>(resolve(response).headers)
          .filter(([name]) => name !== 'apue-replayed')
          .map(([name, header]) => [name.toLowerCase(), resolve(header).schema.const]),
      );
      assert.deepEqual(headers, expected, status);
    }
  });
});

describe('served at /.well-known/openapi.json', () => {
  let server: { url: string; close(): Promise<void> };
  let builds = 0;
  const raw = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, init);

  before(async () => {
    server = await startServer(api, handlers, {
      uploads: {},
      // Lazy build made observable: the document reads its title only when it is built.
      openapi: {
        get title() {
          builds++;
          return 'Served API';
        },
      },
    });
  });
  after(() => server.close());

  test('not built until requested, then built once', async () => {
    assert.equal(builds, 0);
    await (await raw(MANIFEST_PATH)).arrayBuffer();
    await (await raw(CATALOG_PATH)).arrayBuffer();
    await (await raw(`/users.get?i=${encodeURIComponent('{"id":"u-1"}')}`)).arrayBuffer();
    assert.equal(builds, 0);
    const first = await raw(OPENAPI_PATH);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).info.title, 'Served API');
    await (await raw(OPENAPI_PATH)).arrayBuffer();
    await (await raw(OPENAPI_PATH, { method: 'HEAD' })).arrayBuffer();
    assert.equal(builds, 1);
  });

  test('media type, ETag/304, HEAD, 405; the document the server describes', async () => {
    const res = await raw(OPENAPI_PATH);
    assert.equal(res.headers.get('content-type'), OPENAPI_MEDIA_TYPE);
    assert.equal(res.headers.get('content-type'), 'application/openapi+json; version=3.2.0');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    const etag = res.headers.get('etag');
    assert.match(etag ?? '', /^"[^"]+"$/);
    const body = await res.json();
    assertValidOpenApi(body);
    assertExamplesValid(body);
    // From the server's options: uploads on, downloads (t.download() output) on, keys honoured.
    assert.ok(body.paths['/$uploads']);
    assert.ok(body.paths['/$downloads/{id}']);
    assert.ok(body.components.parameters.IdempotencyKey);
    assert.deepEqual(body, JSON.parse(JSON.stringify(buildOpenApi(api, { title: 'Served API', uploads: { maxBytes: 64 * 1024 * 1024, maxAgeSeconds: 3600 }, downloads: true, manifest: MANIFEST_PATH }))));

    const again = await raw(OPENAPI_PATH, { headers: { 'if-none-match': etag! } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), '');
    const changed = await raw(OPENAPI_PATH, { headers: { 'if-none-match': '"other"' } });
    assert.equal(changed.status, 200);
    await changed.arrayBuffer();
    const head = await raw(OPENAPI_PATH, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('etag'), etag);
    assert.equal((await raw(OPENAPI_PATH, { method: 'POST' })).status, 405);
  });

  test('the RFC 9727 catalog links it as a second service-desc', async () => {
    const { port } = new URL(server.url);
    const catalog = await (await raw(CATALOG_PATH)).json();
    assert.deepEqual(catalog.linkset[0]['service-desc'], [
      { href: `https://127.0.0.1:${port}${MANIFEST_PATH}`, type: 'application/json' },
      { href: `https://127.0.0.1:${port}${OPENAPI_PATH}`, type: 'application/openapi+json; version=3.2.0' },
    ]);
  });

  test('the server answers as documented: methods and Idempotency-Key replays', async () => {
    const doc = await (await raw(OPENAPI_PATH)).json();
    for (const name of Object.keys(api)) {
      const item = doc.paths[`/${name}`];
      for (const method of ['GET', 'HEAD', 'QUERY', 'POST', 'PUT', 'DELETE']) {
        const res = await raw(`/${name}`, { method, headers: method === 'QUERY' ? { 'content-type': 'application/json' } : {} });
        await res.arrayBuffer();
        assert.equal(res.status === 405, !item[method.toLowerCase()], `${method} /${name}: ${res.status}`);
      }
    }
    // Keys: documented on orders.create (replayed), not on users.get's POST (a read: never replayed).
    const call = async (name: string, input: unknown) => {
      const res = await raw(`/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': '"k-1"' }, body: JSON.stringify(input) });
      await res.arrayBuffer();
      return res.headers.get('apue-replayed');
    };
    const keyed = (name: string) => (doc.paths[`/${name}`].post.parameters ?? []).some((p: any) => p.$ref === '#/components/parameters/IdempotencyKey');
    assert.equal(keyed('orders.create'), true);
    await call('orders.create', { item: 'x' });
    assert.equal(await call('orders.create', { item: 'x' }), '?1');
    assert.equal(keyed('users.get'), false);
    await call('users.get', { id: 'u-1' });
    assert.equal(await call('users.get', { id: 'u-1' }), null);
  });
});

describe('openapi: false', () => {
  let server: { url: string; close(): Promise<void> };
  before(async () => {
    server = await startServer(defineApi({ ping: op({ effect: 'safe', input: t.void(), output: t.void() }) }) as Api, { ping: () => undefined }, { openapi: false });
  });
  after(() => server.close());

  test('not served, not in the catalog', async () => {
    const res = await fetch(`${server.url}${OPENAPI_PATH}`);
    assert.equal(res.status, 404);
    await res.arrayBuffer();
    const catalog = await (await fetch(`${server.url}${CATALOG_PATH}`)).json();
    assert.deepEqual(catalog.linkset[0]['service-desc'].map((link: { href: string }) => new URL(link.href).pathname), [MANIFEST_PATH]);
  });
});
