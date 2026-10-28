// Operation definitions and the effect → HTTP method mapping (SPEC-DRAFT §4, §5). Shared by
// server and client: TS clients import the API definition, so types and validation come for free.
import type { Infer, Schema } from './schema.ts';

export type Effect = 'safe' | 'idempotent' | 'unsafe';
export type StreamKind = 'none' | 'server' | 'client' | 'bidi';

export interface CachePolicy {
  /** Seconds a response stays fresh. Without a policy, safe responses are `no-cache` (revalidate via ETag). */
  maxAge?: number;
  staleWhileRevalidate?: number;
  /** Responses depend on the caller (e.g. Authorization) → `private`. */
  private?: boolean;
}

export interface Deprecation {
  /** When the op was deprecated (RFC 9745 `Deprecation`). */
  since: Date;
  /** When the op will stop working (RFC 8594 `Sunset`). */
  sunset?: Date;
  /** Successor or migration guide, sent as `Link: <…>; rel="deprecation"`. */
  link?: string;
}

export interface OpDef<I = any, O = any, S extends StreamKind = StreamKind> {
  effect: Effect;
  stream: S;
  /** Schema of the input (or of each input message for client/bidi streams). */
  input: Schema<I>;
  /** Schema of the output (or of each output message for server/bidi streams). */
  output: Schema<O>;
  cache?: CachePolicy;
  deprecated?: Deprecation;
  description?: string;
}

export type Api = Record<string, OpDef>;

export type InputOf<D> = D extends OpDef<infer I, any, any> ? I : never;
export type OutputOf<D> = D extends OpDef<any, infer O, any> ? O : never;

interface OpInit<IS extends Schema<any>, OS extends Schema<any>> {
  effect: Effect;
  input: IS;
  output: OS;
  cache?: CachePolicy;
  deprecated?: Deprecation;
  description?: string;
}

/**
 * Defines an operation; `stream` defaults to 'none'. (Overloads instead of a defaulted type
 * parameter: otherwise the contextual type from defineApi widens S to the whole StreamKind union.)
 */
export function op<IS extends Schema<any>, OS extends Schema<any>>(def: OpInit<IS, OS> & { stream?: 'none' }): OpDef<Infer<IS>, Infer<OS>, 'none'>;
export function op<IS extends Schema<any>, OS extends Schema<any>, const S extends StreamKind>(
  def: OpInit<IS, OS> & { stream: S },
): OpDef<Infer<IS>, Infer<OS>, S>;
export function op(def: OpInit<Schema<unknown>, Schema<unknown>> & { stream?: StreamKind }): OpDef {
  const { since, sunset } = def.deprecated ?? {};
  if (since && sunset && sunset < since) throw new Error('deprecated.sunset must not be earlier than deprecated.since (RFC 9745 §4)');
  return { ...def, stream: def.stream ?? 'none' };
}

export function defineApi<A extends Api>(ops: A): A {
  for (const name of Object.keys(ops)) {
    if (!/^[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)*$/.test(name)) throw new Error(`invalid op name: ${name}`);
  }
  return ops;
}

/** Ops that may be read with GET/QUERY: safe and without a request stream. */
export function isCacheableRead(def: OpDef): boolean {
  return def.effect === 'safe' && (def.stream === 'none' || def.stream === 'server');
}

export function hasRequestStream(def: OpDef): boolean {
  return def.stream === 'client' || def.stream === 'bidi';
}

export function hasResponseStream(def: OpDef): boolean {
  return def.stream === 'server' || def.stream === 'bidi';
}

/** URLs above this length switch from GET to QUERY (CloudFront caps URLs at 8 KiB; stay well below). */
export const MAX_GET_URL = 2048;

/**
 * RFC 8785 JSON Canonicalization Scheme: object keys sorted by UTF-16 code units, ES number and
 * string serialisation (= JSON.stringify). Gives a deterministic GET URL → better cache hit ratio.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError(`not JSON-serialisable: ${typeof value}`);
    return text;
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') return canonicalJson((value as { toJSON(): unknown }).toJSON());
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Path + query for a GET read; `i` carries the canonical input. */
export function readPath(opName: string, input: unknown): string {
  const path = `/${opName}`;
  return input === undefined ? path : `${path}?i=${encodeURIComponent(canonicalJson(input))}`;
}
