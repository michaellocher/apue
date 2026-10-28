// Documentation derived purely from op definitions (research/08): the HTTP shape of each op, the
// errors the protocol itself can answer with, and placeholder examples. Nothing here is written by
// hand and nothing changes the API; it is computed once, with the manifest.
import { hasRequestStream, hasResponseStream, isCacheableRead, MAX_GET_URL, type OpDef } from './api.ts';
import { Header, MediaType, ProblemType, WS_AUTH_PREFIX, WS_SUBPROTOCOL } from './protocol.ts';
import { containsBytes, type Schema } from './schema.ts';

/** A problem a call can be answered with: status and RFC 9457 type (`about:blank` when generic). */
export interface ProblemRef {
  status: number;
  type: string;
  title: string;
}

const ABOUT_BLANK = 'about:blank';
const problem = (status: number, title: string, type = ABOUT_BLANK): ProblemRef => ({ status, type, title });

/** Errors any op call can get from the protocol itself (handlers may add their own, not listed). */
export const PROTOCOL_ERRORS: readonly ProblemRef[] = [
  problem(400, 'Bad Request'), // malformed JSON or ?i=, apue-timeout, Idempotency-Key, nesting, path
  problem(400, 'Validation Failed', ProblemType.VALIDATION),
  problem(400, 'Invalid Selection', ProblemType.INVALID_SELECTION),
  problem(404, 'Unknown Operation', ProblemType.UNKNOWN_OPERATION),
  problem(405, 'Method Not Allowed'),
  problem(413, 'Content Too Large'),
  problem(415, 'Unsupported Media Type'),
  problem(500, 'Internal Server Error'),
  problem(504, 'Deadline Exceeded', ProblemType.DEADLINE),
];

/** Conventions every op follows (SPEC-DRAFT §5–§7): how inputs travel, which headers matter. */
export const HTTP_CONVENTIONS = {
  getInput: `?i=<canonical JSON (RFC 8785), percent-encoded>; above ${MAX_GET_URL} characters clients use QUERY (or POST) with the JSON as body`,
  select: '?s=<comma-separated field paths, e.g. a,b.c>',
  headers: { deadline: Header.TIMEOUT, idempotencyKey: 'idempotency-key', resume: Header.RESUME },
  streams: `${MediaType.STREAM_JSON}: 8-byte frame header (type, flags, lane, length) + payload; examples show single messages`,
  bytes: 'inputs: {"$upload": "<id>"} after POST /$uploads (when enabled); outputs: BLOB frames',
  webSocket: `request streams from browsers: wss://<host>/<op>?timeout=<ms>, subprotocols ${WS_SUBPROTOCOL} and ${WS_AUTH_PREFIX}<Authorization value, base64url without padding>`,
} as const;

export interface OpHttp {
  methods: string[];
  path: string;
  request: string;
  response: string[];
  idempotencyKey?: true;
}

/** The HTTP shape of one op, as the server routes it. */
export function opHttp(name: string, def: OpDef): OpHttp {
  // Mirrors handle(): reads allow GET/HEAD/QUERY/POST, everything else POST.
  const methods = isCacheableRead(def) ? ['GET', 'HEAD', 'QUERY', 'POST'] : ['POST'];
  // Response streams can be rendered as SSE; unary outputs with bytes are framed (MSG + BLOB + END).
  const response = hasResponseStream(def)
    ? [MediaType.STREAM_JSON, MediaType.SSE]
    : [containsBytes(def.output) ? MediaType.STREAM_JSON : MediaType.JSON];
  return {
    methods,
    path: `/${name}`,
    request: hasRequestStream(def) ? MediaType.STREAM_JSON : MediaType.JSON,
    response,
    // Keys are honoured for non-safe plain unary calls only (handle(): `keyed`).
    ...(def.effect !== 'safe' && def.stream === 'none' ? { idempotencyKey: true as const } : {}),
  };
}

/** Errors beyond PROTOCOL_ERRORS that the protocol can answer this op with. */
export function opErrors(def: OpDef): ProblemRef[] {
  const errors: ProblemRef[] = [];
  if (hasRequestStream(def)) {
    errors.push(problem(400, 'Malformed Stream', ProblemType.MALFORMED_STREAM), problem(400, 'Truncated Stream', ProblemType.TRUNCATED_STREAM));
  } else {
    errors.push(problem(408, 'Request Timeout')); // a JSON body not received within bodyTimeoutMs
  }
  if (def.effect !== 'safe' && def.stream === 'none') {
    errors.push(problem(409, 'Idempotency Key In Progress', ProblemType.IDEMPOTENCY_IN_PROGRESS), problem(422, 'Idempotency Key Reused', ProblemType.IDEMPOTENCY_MISMATCH));
  }
  if (def.resumable) errors.push(problem(400, 'Invalid Resume Token', ProblemType.INVALID_RESUME_TOKEN));
  return errors;
}

type JsonSchema = Record<string, any>;

/**
 * A placeholder example for `schema` (rules as Redocly's openapi-sampler: first enum value, minimum
 * or 0, "string" padded/cut to the length bounds, one array item, first anyOf branch, all
 * properties). `json` is the wire form, `value` what the schema validates. Undefined when the
 * schema can't be sampled (e.g. bytes in an output: they travel as BLOB frames).
 */
function sample(schema: JsonSchema, side: 'input' | 'output'): { value: unknown; json: unknown } | undefined {
  if (Array.isArray(schema.anyOf)) {
    // The first branch that can be sampled (a nullable bytes output still has `null`).
    for (const branch of schema.anyOf) {
      const sampled = sample(branch, side);
      if (sampled) return sampled;
    }
    return undefined;
  }
  if (Object.keys(schema).length === 0) return { value: null, json: null }; // t.unknown()
  switch (schema.type) {
    case 'null':
      return { value: null, json: null };
    case 'boolean':
      return { value: true, json: true };
    case 'integer':
    case 'number': {
      const n = schema.minimum ?? (schema.maximum !== undefined && schema.maximum < 0 ? schema.maximum : 0);
      return { value: n, json: n };
    }
    case 'string': {
      if (schema['x-apue-transfer'] !== undefined) return side === 'input' ? { value: new Uint8Array(0), json: { $upload: '<upload id>' } } : undefined;
      if (Array.isArray(schema.enum)) return { value: schema.enum[0], json: schema.enum[0] };
      let text = 'string';
      if (schema.minLength !== undefined && text.length < schema.minLength) text = text.padEnd(schema.minLength, 'x');
      if (schema.maxLength !== undefined && text.length > schema.maxLength) text = text.slice(0, schema.maxLength);
      return { value: text, json: text };
    }
    case 'array': {
      if (schema.maxItems === 0) return { value: [], json: [] };
      const item = sample(schema.items ?? {}, side);
      return item && { value: [item.value], json: [item.json] };
    }
    case 'object': {
      const value: Record<string, unknown> = {};
      const json: Record<string, unknown> = {};
      const required = new Set<string>(schema.required ?? []);
      for (const [key, property] of Object.entries<JsonSchema>(schema.properties ?? {})) {
        const field = sample(property, side);
        if (!field) {
          if (required.has(key)) return undefined;
          continue; // an optional field that can't be shown (e.g. bytes) is left out, not the whole example
        }
        value[key] = field.value;
        json[key] = field.json;
      }
      return { value, json };
    }
    default:
      return undefined;
  }
}

/**
 * Placeholder input/output examples for an op (single messages for streams). Each is validated
 * with the op's own schema and left out when it doesn't pass (e.g. a regex pattern the placeholder
 * can't meet) — an invalid example is never published. Void inputs/outputs have none.
 */
export function opExample(def: OpDef): { input?: unknown; output?: unknown } {
  const example: { input?: unknown; output?: unknown } = {};
  for (const side of ['input', 'output'] as const) {
    const schema: Schema<unknown> = def[side];
    const json = schema.toJSONSchema();
    if (json.type === 'null') continue;
    const sampled = sample(json, side);
    if (!sampled) continue;
    try {
      schema.parse(sampled.value);
      example[side] = sampled.json;
    } catch {
      // not publishable: leave it out
    }
  }
  return example;
}
