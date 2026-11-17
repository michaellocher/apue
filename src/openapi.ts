// OpenAPI 3.2 description derived from the op definitions only (research/07–08): no API change,
// nothing hand-written. Each op is described as the server routes it (handle() in server.ts, the
// same rules as opHttp/opErrors in docs.ts). What OpenAPI cannot express stays opaque and is
// carried by `x-apue-*` extensions: the frame format of `application/vnd.apue.frames` (itemSchema is
// only for sequential media types without envelopes or metadata, OAS 3.2 §4.14.3.1 — our frames have
// an 8-byte header), the per-message schema of streams, the op back-reference. Web-platform only.
import { canonicalJson, deprecationHeaders, hasRequestStream, hasResponseStream, isCacheableRead, MAX_GET_URL, type Api, type OpDef } from './api.ts';
import { opErrors, opExample, PROTOCOL_ERRORS, type ProblemRef } from './docs.ts';
import { DOWNLOADS_PATH, Header, MAX_TIMEOUT_MS, MediaType, ProblemType, UPLOAD_INTEROP_VERSION, UPLOADS_PATH } from './protocol.ts';
import { containsBytes, t } from './schema.ts';
import { MAX_SELECT_PATHS, selectableFields } from './select.ts';

export const OPENAPI_VERSION = '3.2.0';
/**
 * draft-ietf-httpapi-rest-api-mediatypes defines `application/openapi+json` with a `version`
 * parameter; it is not an RFC and the type is not in the IANA registry yet (checked 2026-10-28,
 * research/07) — used de facto, as tools and the draft's examples do.
 */
export const OPENAPI_MEDIA_TYPE = `application/openapi+json; version=${OPENAPI_VERSION}`;
/** apü emits plain JSON Schema 2020-12 (no OAS vocabulary: discriminator, xml, example). */
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** Describes the document; all optional. */
export interface OpenApiInfo {
  /** `info.title`. Default "apü API". */
  title?: string;
  /** `info.version`, the version of this description. Default "0.0.0". */
  version?: string;
  /** `info.description` (CommonMark). Default: a summary of the apü conventions. */
  description?: string;
  /** Default `[{ url: '/' }]`: relative to where the document is served, i.e. the same origin. */
  servers?: Array<{ url: string; description?: string }>;
}

/** What only the serving server knows (like the manifest's `limits`). */
export interface OpenApiOptions extends OpenApiInfo {
  /** Idempotency-Key replays enabled (server option `idempotency` not false). Default true. */
  idempotency?: boolean;
  /** `/$uploads` is served (server option `uploads`). */
  uploads?: { maxBytes: number; maxAgeSeconds: number };
  /** `/$downloads/{id}` is served (t.download() outputs or server option `downloads`). */
  downloads?: boolean;
  /** Path of the apü manifest, linked as `x-apue-manifest`. */
  manifest?: string;
}

type Json = Record<string, any>;

const SCHEMAS = '#/components/schemas/';
const ref = (kind: string, name: string) => ({ $ref: `#/components/${kind}/${name}` });
const schemaRef = (name: string) => ({ $ref: SCHEMAS + name });

const DEFAULT_DESCRIPTION = `Generated from the apü operation definitions (not hand-written).

- Reads (safe ops without a request stream) are \`GET /{op}?i={input}\` with the input as RFC 8785 canonical JSON, percent-encoded; inputs that make the URL longer than ${MAX_GET_URL} characters go as \`QUERY\` (or \`POST\` where QUERY is blocked) with the JSON as body. Responses carry a strong ETag; \`If-None-Match\` gives 304.
- Everything else is \`POST /{op}\` with a JSON body; non-safe unary calls should send an \`Idempotency-Key\` and may then be retried.
- \`application/vnd.apue.frames\` bodies are length-prefixed frames, not JSON: an 8-byte header (type, flags, lane u16, length u32) and a payload. MSG payloads are JSON messages (schema in \`x-apue-message-schema\`; \`t.bytes()\` values as \`{"$blob": k}\` references to the BLOB frames sent before the MSG, look-alike values escaped as \`{"$lit": value}\`), an END frame \`{status, problem?}\` ends the stream — a body without END is truncated. Server streams can also be read as \`text/event-stream\`.
- Errors are RFC 9457 problem details. Handlers and the application can answer with more than the protocol errors listed per operation (see \`default\`).`;

/** Builds the OpenAPI 3.2 description of `api`. Pure; a few milliseconds for a large API. */
export function buildOpenApi(api: Api, options: OpenApiOptions = {}): Json {
  const shared: Shared = { used: new Set(['Problem']), opSchemas: new Map(), parameters: new Map(), examples: new Map(), responses: new Map(), headers: new Map() };
  const tags = new Set<string>();
  const paths: Json = {};
  const honoursKeys = options.idempotency !== false;

  for (const [name, def] of Object.entries(api)) {
    const tag = name.includes('.') ? name.slice(0, name.indexOf('.')) : undefined;
    if (tag) tags.add(tag);
    const ctx: OpContext = { ...shared, name, def, tag, honoursKeys };
    const item: Json = {};
    if (def.description) item.description = def.description;
    const parameters: Json[] = [ref('parameters', 'Timeout')];
    const selection = selectionParameter(def);
    if (selection) parameters.push(selection);
    item.parameters = parameters;
    if (isCacheableRead(def)) {
      // handle(): reads allow GET, HEAD, QUERY and POST (the QUERY fallback); clients use GET up
      // to MAX_GET_URL, then QUERY.
      item.get = operation(ctx, 'get');
      item.head = operation(ctx, 'head');
      item.query = operation(ctx, 'query');
      item.post = operation(ctx, 'post');
    } else {
      item.post = operation(ctx, 'post');
    }
    paths[`/${name}`] = item;
  }
  if (options.uploads) Object.assign(paths, uploadPaths(options.uploads));
  if (options.downloads) Object.assign(paths, downloadPaths(shared.used));

  const schemas: Json = {};
  for (const name of [...shared.used].sort()) schemas[name] = COMPONENT_SCHEMAS[name]!();
  return {
    openapi: OPENAPI_VERSION,
    info: { title: options.title ?? 'apü API', version: options.version ?? '0.0.0', description: options.description ?? DEFAULT_DESCRIPTION },
    jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    servers: options.servers ?? [{ url: '/' }],
    ...(tags.size > 0 ? { tags: [...tags].sort().map((tag) => ({ name: tag })) } : {}),
    paths,
    components: {
      schemas: { ...schemas, ...sorted(shared.opSchemas) },
      parameters: { ...COMMON_PARAMETERS(honoursKeys), ...sorted(shared.parameters) },
      headers: { ...COMMON_HEADERS, ...sorted(shared.headers) },
      examples: sorted(shared.examples),
      responses: {
        Error: {
          description:
            'Errors raised by the handler or the application (e.g. 401 from a principal hook, 503 while the server shuts down): RFC 9457 problem details.',
          content: { [MediaType.PROBLEM]: { schema: schemaRef('Problem') } },
        },
        ...sorted(shared.responses),
      },
    },
    ...(options.manifest ? { 'x-apue-manifest': options.manifest } : {}),
  };
}

/** Components collected while describing the ops. */
interface Shared {
  /** Fixed component schemas referenced (COMPONENT_SCHEMAS). */
  used: Set<string>;
  /**
   * Per-op schemas in wire form: `<op>.Input`, `<op>.Output`, `<op>.Event` (SSE). Unique: op names
   * are dotted identifiers, so what follows the last dot names the part (likewise below).
   */
  opSchemas: Map<string, Json>;
  /** The `?i=` parameter per read, `<op>.i`. */
  parameters: Map<string, Json>;
  /** Problem examples by slug. */
  examples: Map<string, Json>;
  /** Problem responses per status and set of problem kinds. */
  responses: Map<string, Json>;
  /** Response headers of deprecated ops, `<op>.Deprecation` etc. */
  headers: Map<string, Json>;
}

interface OpContext extends Shared {
  name: string;
  def: OpDef;
  tag: string | undefined;
  honoursKeys: boolean;
}

const sorted = (map: Map<string, Json>): Json => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : 1)));

/**
 * The op's input or output in wire form, as a named component (reads reference it from four
 * operations). Unary JSON bodies carry bytes as upload references, frames as BLOB references.
 */
function opSchema(ctx: OpContext, side: 'input' | 'output'): Json {
  const key = `${ctx.name}.${side === 'input' ? 'Input' : 'Output'}`;
  if (!ctx.opSchemas.has(key)) {
    const framedSide = side === 'input' ? hasRequestStream(ctx.def) : hasResponseStream(ctx.def) || containsBytes(ctx.def.output);
    ctx.opSchemas.set(key, wire(ctx.def[side].toJSONSchema(), framedSide ? 'frames' : 'upload', ctx.used));
  }
  return schemaRef(key);
}

type Method = 'get' | 'head' | 'query' | 'post';

function operation(ctx: OpContext, method: Method): Json {
  const { name, def } = ctx;
  const read = isCacheableRead(def);
  // Keys are honoured for non-safe plain unary calls only (handle(): `keyed`), if the store is on.
  const keyed = ctx.honoursKeys && def.effect !== 'safe' && def.stream === 'none';
  const parameters: Json[] = [];
  if (method === 'get' || method === 'head') {
    // A component: GET and HEAD share it.
    const key = `${name}.i`;
    if (!ctx.parameters.has(key)) {
      const input = inputParameter(ctx);
      if (input) ctx.parameters.set(key, input);
    }
    if (ctx.parameters.has(key)) parameters.push(ref('parameters', key));
  }
  if (keyed) parameters.push(ref('parameters', 'IdempotencyKey'));
  if (def.resumable) parameters.push(ref('parameters', 'Resume'));
  const unaryRead = read && !hasResponseStream(def);
  if (unaryRead) parameters.push(ref('parameters', 'IfNoneMatch'));

  const op: Json = {
    operationId: read && method !== 'get' ? `${name}:${method}` : name,
    ...(ctx.tag ? { tags: [ctx.tag] } : {}),
    summary: summary(def, method),
    ...(def.description ? { description: def.description } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
  };
  if (method === 'query' || method === 'post') op.requestBody = requestBody(ctx);
  op.responses = responses(ctx, method, keyed, unaryRead);
  if (def.deprecated) op.deprecated = true;
  op['x-apue-op'] = name;
  return op;
}

function summary(def: OpDef, method: Method): string {
  const kind = def.stream === 'none' ? 'unary' : `${def.stream} stream`;
  const how = method === 'get' ? 'input in ?i=' : method === 'head' ? 'headers only' : method === 'query' ? 'input as body (long inputs)' : hasRequestStream(def) ? 'framed request stream' : 'input as body';
  return `${def.effect} ${kind}, ${how}`;
}

/** `?i=`: JSON in a query parameter, OAS 3.2 §4.12.2 — `content` (not `schema`) with exactly one entry. */
function inputParameter(ctx: OpContext): Json | undefined {
  const { def } = ctx;
  if (def.input.toJSONSchema().type === 'null') return undefined; // void: no input to send
  const parameter: Json = {
    name: 'i',
    in: 'query',
    required: !acceptsUndefined(def),
    description: `The input as RFC 8785 canonical JSON, percent-encoded. Longer than ${MAX_GET_URL} characters in total: use QUERY.`,
    content: { [MediaType.JSON]: { schema: opSchema(ctx, 'input') } },
  };
  const example = opExample(def).input;
  if (example !== undefined) {
    parameter.examples = {
      placeholder: { summary: PLACEHOLDER, dataValue: example, serializedValue: `i=${encodeURIComponent(canonicalJson(example))}` },
    };
  }
  return parameter;
}

const PLACEHOLDER = 'Generated placeholder, validated against the schema';

function acceptsUndefined(def: OpDef): boolean {
  try {
    def.input.parse(undefined);
    return true;
  } catch {
    return false;
  }
}

function selectionParameter(def: OpDef): Json | undefined {
  const fields = selectableFields(def.output);
  if (!fields || fields.length === 0) return undefined;
  return {
    name: 's',
    in: 'query',
    required: false,
    description: `Field selection: up to ${MAX_SELECT_PATHS} comma-separated paths into the output (through objects, arrays and nullable fields), e.g. \`a,b.c\`. Unknown paths: 400 invalid-selection. Top-level fields: ${fields.join(', ')}.`,
    schema: { type: 'string' },
    examples: { fields: { summary: 'Two top-level fields', dataValue: fields.slice(0, 2).join(',') } },
  };
}

function requestBody(ctx: OpContext): Json {
  const { def } = ctx;
  if (hasRequestStream(def)) {
    return {
      description: 'A framed request stream: one MSG per input message, then END. Browsers without request streaming use WebSocket (subprotocol apue.v1) instead.',
      required: true,
      // The placeholder's bytes would be an upload reference; in frames they are BLOB references.
      content: { [MediaType.STREAM_JSON]: framed(ctx, opSchema(ctx, 'input'), containsBytes(def.input) ? undefined : opExample(def).input) },
    };
  }
  const media: Json = { schema: opSchema(ctx, 'input') };
  const example = opExample(def).input;
  if (example !== undefined) media.examples = { placeholder: { summary: PLACEHOLDER, dataValue: example } };
  return {
    ...(containsBytes(def.input) ? { description: `Binary values travel as upload references: upload first (POST ${UPLOADS_PATH}), then send {"$upload": id}.` } : {}),
    required: !acceptsUndefined(def),
    content: { [MediaType.JSON]: media },
  };
}

/** Media Type Object for `application/vnd.apue.frames`: opaque frames, the message schema as an extension. */
function framed(ctx: OpContext, messageSchema: Json, example: unknown): Json {
  ctx.used.add('End');
  return {
    description: 'apü frames, not a JSON document (see the API description): MSG payloads as x-apue-message-schema, END as End.',
    'x-apue-message-schema': messageSchema,
    ...(example === undefined ? {} : { 'x-apue-message-example': example }),
  };
}

/** `text/event-stream` (OAS 3.2 §4.14.4): one event per frame, JSON in `data`. */
function sseItemSchema(ctx: OpContext, messageSchema: Json): Json {
  const key = `${ctx.name}.Event`; // a component: reads reference it from three operations
  if (!ctx.opSchemas.has(key)) ctx.opSchemas.set(key, sseEvent(messageSchema, containsBytes(ctx.def.output)));
  return schemaRef(key);
}

function sseEvent(messageSchema: Json, bytes: boolean): Json {
  return {
    type: 'object',
    required: ['event', 'data'],
    properties: {
      event: { type: 'string' },
      data: { type: 'string' },
      id: { type: 'string', description: 'Resume token of the latest checkpoint (resumable ops); reconnect with Last-Event-ID or apue-resume.' },
    },
    oneOf: [
      { properties: { event: { const: 'msg' }, data: { contentMediaType: MediaType.JSON, contentSchema: messageSchema } } },
      { properties: { event: { const: 'end' }, data: { contentMediaType: MediaType.JSON, contentSchema: schemaRef('End') } } },
      ...(bytes ? [{ properties: { event: { const: 'blob' }, data: { contentEncoding: 'base64', description: 'A chunk of the next message’s binary value' } } }] : []),
    ],
  };
}

function responses(ctx: OpContext, method: Method, keyed: boolean, unaryRead: boolean): Json {
  const { def } = ctx;
  const deprecation = def.deprecated ? deprecationResponseHeaders(ctx) : {};
  const headers: Json = { ...deprecation };
  if (unaryRead) headers.ETag = ref('headers', 'ETag');
  if (keyed) headers['apue-replayed'] = ref('headers', 'Replayed');
  const ok: Json = { description: hasResponseStream(def) ? 'The stream (errors after the first message arrive in its END frame)' : 'The output' };
  if (Object.keys(headers).length > 0) ok.headers = headers;
  if (method !== 'head') ok.content = successContent(ctx);
  const out: Json = { '200': ok };
  if (unaryRead) out['304'] = { description: 'Not Modified (If-None-Match matched the ETag)', ...(def.deprecated ? { headers: deprecation } : {}) };
  if (method === 'head') {
    out.default = { description: 'An error (status only: HEAD responses have no content)' };
    return out;
  }
  for (const [status, problems] of groupByStatus(opProblems(def, method, keyed))) {
    const response = {
      description: problems.map((p) => p.title).join('; '),
      ...(def.deprecated ? { headers: deprecation } : {}),
      content: {
        [MediaType.PROBLEM]: {
          schema: schemaRef('Problem'),
          examples: Object.fromEntries(problems.map((p) => [problemSlug(p), problemExample(ctx, p)])),
        },
      },
    };
    if (def.deprecated) {
      out[status] = response; // its own headers: not shareable
    } else {
      // Shared per status and set of problem kinds: most ops (and all methods of a read) reuse them.
      const name = problemResponseName(Number(status), problems);
      ctx.responses.set(name, response);
      out[status] = ref('responses', name);
    }
  }
  out.default = ref('responses', 'Error');
  return out;
}

/** `Problem400` for the common problems of a status, else the status and every kind (a unique key). */
function problemResponseName(status: number, problems: ProblemRef[]): string {
  const slugs = problems.map(problemSlug);
  const common = PROTOCOL_ERRORS.filter((p) => p.status === status).map(problemSlug);
  return slugs.join() === common.join() ? `Problem${status}` : `Problem${status}.${slugs.join('.')}`;
}

function successContent(ctx: OpContext): Json {
  const { def } = ctx;
  const example = opExample(def).output;
  if (hasResponseStream(def)) {
    const message = opSchema(ctx, 'output');
    return {
      [MediaType.STREAM_JSON]: framed(ctx, message, example),
      // Rendered for `Accept: text/event-stream` (curl, EventSource, devtools).
      [MediaType.SSE]: { itemSchema: sseItemSchema(ctx, message) },
    };
  }
  if (containsBytes(def.output)) {
    // Unary outputs with bytes are answered framed: BLOB frames, one MSG, END.
    return { [MediaType.STREAM_JSON]: framed(ctx, opSchema(ctx, 'output'), example) };
  }
  const media: Json = { schema: opSchema(ctx, 'output') };
  if (example !== undefined) media.examples = { placeholder: { summary: PLACEHOLDER, dataValue: example } };
  return { [MediaType.JSON]: media };
}

/**
 * The protocol errors of one operation: PROTOCOL_ERRORS + opErrors, without those that cannot
 * answer a documented method on a documented path (404 unknown operation, 405), without the
 * body errors for GET (no body), and without 409/422 when keys are not honoured.
 */
function opProblems(def: OpDef, method: Method, keyed: boolean): ProblemRef[] {
  return [...PROTOCOL_ERRORS, ...opErrors(def)].filter((p) => {
    if (p.type === ProblemType.UNKNOWN_OPERATION || p.status === 405) return false;
    if (method === 'get' && (p.status === 408 || p.status === 413 || p.status === 415)) return false;
    if (!keyed && (p.type === ProblemType.IDEMPOTENCY_IN_PROGRESS || p.type === ProblemType.IDEMPOTENCY_MISMATCH)) return false;
    return true;
  });
}

function groupByStatus(problems: ProblemRef[]): Array<[string, ProblemRef[]]> {
  const groups = new Map<number, ProblemRef[]>();
  for (const p of problems) groups.set(p.status, [...(groups.get(p.status) ?? []), p]);
  return [...groups].sort(([a], [b]) => a - b).map(([status, list]) => [String(status), list]);
}

function problemSlug(p: ProblemRef): string {
  return p.type === 'about:blank' ? p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') : p.type.slice(p.type.lastIndexOf('/') + 1);
}

/** A shared Example Object per problem kind; generic problems omit `type` on the wire (about:blank). */
function problemExample(ctx: OpContext, p: ProblemRef): Json {
  const slug = problemSlug(p);
  if (!ctx.examples.has(slug)) {
    ctx.examples.set(slug, {
      summary: p.title,
      dataValue: { ...(p.type === 'about:blank' ? {} : { type: p.type }), title: p.title, status: p.status },
    });
  }
  return ref('examples', slug);
}

/** The op's Deprecation/Sunset/Link headers (exact values: the server sends these), as components. */
function deprecationResponseHeaders(ctx: OpContext): Json {
  const doc: Record<string, string> = {
    deprecation: 'RFC 9745: when the operation was deprecated',
    sunset: 'RFC 8594: when it stops working',
    link: 'The successor or migration guide (rel="deprecation")',
  };
  const refs: Json = {};
  for (const [name, value] of Object.entries(deprecationHeaders(ctx.def.deprecated!))) {
    const field = name[0]!.toUpperCase() + name.slice(1);
    ctx.headers.set(`${ctx.name}.${field}`, { description: doc[name], schema: { type: 'string', const: value } });
    refs[field] = ref('headers', `${ctx.name}.${field}`);
  }
  return refs;
}

/**
 * The wire form of an apü JSON Schema. Unary inputs ('upload'): t.bytes()/t.file() values are
 * upload references. Frames ('frames'): t.bytes() values are BLOB references. t.download()
 * outputs are download references either way. `x-apue-*` keywords stay.
 */
function wire(schema: Json, mode: 'upload' | 'frames', used: Set<string>): Json {
  const transfer = schema['x-apue-transfer'];
  if (transfer === 'blob-frames' || transfer === 'upload') {
    const { type: _type, contentEncoding: _encoding, contentMediaType: _media, 'x-apue-transfer': _transfer, ...rest } = schema;
    const target = mode === 'upload' ? 'UploadReference' : 'BlobReference';
    used.add(target);
    return { ...schemaRef(target), ...rest, 'x-apue-transfer': mode === 'upload' ? 'upload' : 'blob-frames' };
  }
  if (transfer === 'download') {
    const { type: _type, properties: _properties, required: _required, ...rest } = schema;
    used.add('DownloadReference');
    return { ...schemaRef('DownloadReference'), ...rest };
  }
  const out: Json = { ...schema };
  if (schema.properties) out.properties = Object.fromEntries(Object.entries<Json>(schema.properties).map(([key, value]) => [key, wire(value, mode, used)]));
  if (schema.items) out.items = wire(schema.items, mode, used);
  if (schema.anyOf) out.anyOf = schema.anyOf.map((branch: Json) => wire(branch, mode, used));
  return out;
}

const COMPONENT_SCHEMAS: Record<string, () => Json> = {
  Problem: () => ({
    type: 'object',
    description:
      'RFC 9457 problem details. apü protocol errors have type URIs under https://michaellocher.github.io/apue/problems/; generic errors omit type (about:blank) and use the status phrase as title.',
    properties: {
      type: { type: 'string', format: 'uri-reference', default: 'about:blank' },
      title: { type: 'string' },
      status: { type: 'integer', minimum: 100, maximum: 599 },
      detail: { type: 'string' },
      instance: { type: 'string', format: 'uri-reference' },
      retryable: { type: 'boolean', description: 'apü extension: the same request may succeed when retried' },
      fields: {
        type: 'array',
        description: 'apü extension: per-field validation errors',
        items: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' } }, required: ['path', 'message'] },
      },
    },
    required: ['title', 'status'],
  }),
  End: () => ({
    type: 'object',
    description: 'Payload of the END frame that terminates a stream (status 200, or the error that ended it).',
    properties: { status: { type: 'integer' }, problem: schemaRef('Problem'), meta: { type: 'object' } },
    required: ['status'],
  }),
  UploadReference: () => ({
    type: 'object',
    description: `Binary input, uploaded before the call (POST ${UPLOADS_PATH}; the id from its response).`,
    properties: { $upload: { type: 'string' } },
    required: ['$upload'],
    additionalProperties: false,
  }),
  BlobReference: () => ({
    type: 'object',
    description: 'Binary value carried by the BLOB frames sent before this message: k-th blob of the message, from 0.',
    properties: { $blob: { type: 'integer', minimum: 0 } },
    required: ['$blob'],
    additionalProperties: false,
  }),
  DownloadReference: () => {
    const { 'x-apue-transfer': _transfer, ...schema } = t.download().toJSONSchema();
    return { ...schema, description: `A short-lived download URL (${DOWNLOADS_PATH}/{id}): GET with Range, If-Range, ETag.` };
  },
  UploadCreated: () => ({
    type: 'object',
    properties: { upload: { type: 'string' }, size: { type: 'integer', minimum: 0 } },
    required: ['upload', 'size'],
  }),
};

const COMMON_PARAMETERS = (honoursKeys: boolean): Json => ({
  Timeout: {
    name: Header.TIMEOUT,
    in: 'header',
    required: false,
    description: 'Deadline in milliseconds (RFC 9651 Integer). The server aborts the call and answers 504 deadline-exceeded.',
    schema: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS },
  },
  ...(honoursKeys
    ? {
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: false,
          description:
            'Client-generated key (RFC 9651 String, e.g. a UUID; draft-ietf-httpapi-idempotency-key-header). The same key with the same input replays the stored response (apue-replayed: ?1); with another input: 422; while the first is running: 409 (retryable). Scoped to the operation and the caller.',
          schema: { type: 'string', minLength: 1 },
        },
      }
    : {}),
  Resume: {
    name: Header.RESUME,
    in: 'header',
    required: false,
    description: 'Resume token from the stream’s latest CHECKPOINT frame (SSE: Last-Event-ID): the stream continues after it. Invalid, expired or foreign tokens: 400 invalid-resume-token.',
    schema: { type: 'string' },
  },
  IfNoneMatch: {
    name: 'If-None-Match',
    in: 'header',
    required: false,
    description: 'ETag(s) of a stored response: 304 if it is still current.',
    schema: { type: 'string' },
  },
});

const COMMON_HEADERS: Json = {
  ETag: { description: 'Strong validator (hash of the representation, content-coding included).', schema: { type: 'string' } },
  Replayed: { description: 'apü extension: ?1 when this is a stored Idempotency-Key replay (RFC 9651 Boolean).', schema: { type: 'string', const: '?1' } },
};

const problemResponse = (description: string): Json => ({ description, content: { [MediaType.PROBLEM]: { schema: schemaRef('Problem') } } });
const header = (description: string, schema: Json = { type: 'string' }): Json => ({ description, schema });

/** `/$uploads` (draft-ietf-httpbis-resumable-upload-14, interop version 10) as served by uploads.ts. */
function uploadPaths(limits: NonNullable<OpenApiOptions['uploads']>): Json {
  const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{22}$' } };
  const sfBoolean = { type: 'string', enum: ['?0', '?1'] };
  const state = {
    'Upload-Offset': header('Bytes received so far', { type: 'integer', minimum: 0 }),
    'Upload-Complete': header('Whether the upload is complete', sfBoolean),
    'Upload-Limit': header(`Limits, e.g. max-size=${limits.maxBytes}, max-age=${limits.maxAgeSeconds}`),
    'Upload-Length': header('Announced total length, if known', { type: 'integer', minimum: 0 }),
  };
  const created = {
    description: 'Complete: the reference for op inputs ({"$upload": upload})',
    headers: { Location: header('The upload resource'), 'Upload-Complete': header('?1: complete', sfBoolean) },
    content: { [MediaType.JSON]: { schema: schemaRef('UploadCreated') } },
  };
  const offset = { description: 'Offset retrieval', headers: state };
  return {
    [UPLOADS_PATH]: {
      description: `Resumable uploads (draft-ietf-httpbis-resumable-upload-14, Upload-Draft-Interop-Version ${UPLOAD_INTEROP_VERSION}) for t.bytes()/t.file() inputs: at most ${limits.maxBytes} bytes per upload, kept ${limits.maxAgeSeconds} s. Visible to the caller that created them only.`,
      options: { operationId: '$uploads:options', responses: { '204': { description: 'Discovery', headers: { 'Upload-Limit': state['Upload-Limit'] } } } },
      post: {
        operationId: '$uploads:create',
        parameters: [
          { name: 'Upload-Complete', in: 'header', required: false, description: '?0 for a resumable upload sent in parts (default ?1)', schema: sfBoolean },
          { name: 'Upload-Length', in: 'header', required: false, schema: { type: 'integer', minimum: 0 } },
          { name: 'Upload-Draft-Interop-Version', in: 'header', required: false, description: `${UPLOAD_INTEROP_VERSION}: 104 (Upload Resumption Supported) with Location, over HTTP/2`, schema: { type: 'string' } },
        ],
        requestBody: { required: false, content: { 'application/octet-stream': {} } },
        responses: {
          '104': { description: 'Upload Resumption Supported', headers: { Location: header('The upload resource'), 'Upload-Limit': state['Upload-Limit'] } },
          '201': { ...created, description: `${created.description}; or, with Upload-Complete: ?0, the incomplete upload`, headers: { ...created.headers, ...state } },
          '400': problemResponse('Malformed upload headers; inconsistent-upload-length'),
          '413': problemResponse('Larger than the upload limit'),
          '503': problemResponse('Upload storage is full (retryable)'),
          '507': problemResponse('This client’s upload quota is used up'),
          default: ref('responses', 'Error'),
        },
      },
    },
    [`${UPLOADS_PATH}/{id}`]: {
      parameters: [id],
      head: { operationId: '$uploads:offset', responses: { '204': offset, '404': { description: 'Unknown, expired or not yours' } } },
      get: { operationId: '$uploads:offset:get', responses: { '204': offset, '404': problemResponse('Unknown, expired or not yours') } },
      patch: {
        operationId: '$uploads:append',
        parameters: [
          { name: 'Upload-Offset', in: 'header', required: true, schema: { type: 'integer', minimum: 0 } },
          { name: 'Upload-Complete', in: 'header', required: true, schema: sfBoolean },
          { name: 'Upload-Length', in: 'header', required: false, schema: { type: 'integer', minimum: 0 } },
        ],
        requestBody: { required: true, content: { 'application/partial-upload': {} } },
        responses: {
          '201': created,
          '204': { description: 'Appended; not complete yet', headers: state },
          '400': problemResponse('Malformed headers; inconsistent-upload-length'),
          '404': problemResponse('Unknown, expired or not yours'),
          '409': problemResponse('mismatching-upload-offset (expected-offset), already complete, or superseded by a newer append'),
          '413': problemResponse('Larger than the upload limit'),
          '415': problemResponse('Content-Type must be application/partial-upload'),
          default: ref('responses', 'Error'),
        },
      },
      delete: { operationId: '$uploads:cancel', responses: { '204': { description: 'Deleted' }, '404': problemResponse('Unknown, expired or not yours') } },
    },
  };
}

/** `/$downloads/{id}` for t.download() outputs, as served by downloads.ts. */
function downloadPaths(used: Set<string>): Json {
  used.add('DownloadReference');
  const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{22}$' } };
  const headers = {
    ETag: ref('headers', 'ETag'),
    'Accept-Ranges': header('bytes'),
    'Cache-Control': header('private, max-age=<remaining lifetime>, immutable'),
    'Content-Disposition': header('RFC 6266, when the source has a filename'),
    'Repr-Digest': header('RFC 9530 sha-256, when the digest is known'),
  };
  const parameters = [
    { name: 'Range', in: 'header', required: false, description: 'One byte range (several ranges or invalid syntax are ignored: 200)', schema: { type: 'string' } },
    { name: 'If-Range', in: 'header', required: false, description: 'The ETag: the range applies only to the same representation', schema: { type: 'string' } },
    ref('parameters', 'IfNoneMatch'),
  ];
  const responses = (body: boolean): Json => ({
    '200': { description: 'The content', headers, ...(body ? { content: { '*/*': {} } } : {}) },
    '206': { description: 'The requested range', headers: { ...headers, 'Content-Range': header('bytes start-end/size') }, ...(body ? { content: { '*/*': {} } } : {}) },
    '304': { description: 'Not Modified' },
    '404': body ? problemResponse('Unknown or expired: call the operation again for a fresh URL') : { description: 'Unknown or expired' },
    '416': { description: 'Range Not Satisfiable', headers: { 'Content-Range': header('bytes */size') } },
  });
  return {
    [`${DOWNLOADS_PATH}/{id}`]: {
      description: 'Download resources for t.download() outputs: the URL (from a DownloadReference) is a short-lived capability.',
      parameters: [id],
      get: { operationId: '$downloads:get', parameters, responses: responses(true) },
      head: { operationId: '$downloads:head', parameters, responses: responses(false) },
    },
  };
}
