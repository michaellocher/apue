// Minimal TS-first schema builder (SPEC-DRAFT §11): runtime validation + static inference +
// JSON Schema export, from one definition. Web-only, erasable syntax only.
//
// Hot path: validation runs for every message of a stream, so the success path allocates only
// the normalised output. Issue paths are a mutable segment stack, formatted only on failure
// (bench/schema-micro.ts).

export interface Issue {
  path: string;
  message: string;
}

const bytesCache = new WeakMap<Schema<unknown>, boolean>();

/** Whether a schema contains `t.bytes()` anywhere (decides between the fast JSON path and blob framing). */
export function containsBytes(schema: Schema<unknown>): boolean {
  const cached = bytesCache.get(schema);
  if (cached !== undefined) return cached;
  bytesCache.set(schema, false); // cycle guard
  const result =
    schema.kind === 'bytes' ||
    (schema.element !== undefined && containsBytes(schema.element)) ||
    (schema.inner !== undefined && containsBytes(schema.inner)) ||
    (schema.fields !== undefined && Object.values(schema.fields).some(containsBytes));
  bytesCache.set(schema, result);
  return result;
}

export class ValidationError extends Error {
  readonly issues: Issue[];

  constructor(issues: Issue[]) {
    super(issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; '));
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/** Validation state shared down the tree: current path (segment stack) and collected issues. */
export interface CheckContext {
  path: Array<string | number>;
  issues: Issue[];
}

export interface Schema<T> {
  readonly kind: string;
  /** Validates and returns a normalised value (unknown object keys are dropped). */
  parse(value: unknown): T;
  /** Collects issues into `ctx` instead of throwing; the result is meaningless if issues were added. */
  check(value: unknown, ctx: CheckContext): T | undefined;
  toJSONSchema(): Record<string, unknown>;
  /** Structure for field selection (select.ts): object fields, array element, wrapped schema. */
  readonly fields?: Readonly<Record<string, Schema<unknown>>>;
  readonly element?: Schema<unknown>;
  readonly inner?: Schema<unknown>;
  /** Phantom field carrying the static type. Never set at runtime. */
  readonly __type?: T;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

interface OptionalMarker {
  readonly optional: true;
}

type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends OptionalMarker ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type InferShape<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> }
>;

function define<T>(
  kind: string,
  check: (value: unknown, ctx: CheckContext) => T | undefined,
  jsonSchema: () => Record<string, unknown>,
): Schema<T> {
  return {
    kind,
    check,
    toJSONSchema: jsonSchema,
    parse(value) {
      const ctx: CheckContext = { path: [], issues: [] };
      const result = check(value, ctx);
      if (ctx.issues.length > 0) throw new ValidationError(ctx.issues);
      return result as T;
    },
  };
}

function withStructure<T>(structure: Pick<Schema<T>, 'fields' | 'element' | 'inner'>, schema: Schema<T>): Schema<T> {
  return Object.assign(schema, structure);
}

function report(ctx: CheckContext, message: string): undefined {
  let path = '';
  for (const segment of ctx.path) path = typeof segment === 'number' ? `${path}[${segment}]` : path ? `${path}.${segment}` : segment;
  ctx.issues.push({ path, message });
  return undefined;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export interface StringOptions {
  min?: number;
  max?: number;
  pattern?: RegExp;
}

export interface NumberOptions {
  int?: boolean;
  min?: number;
  max?: number;
}

export interface ArrayOptions {
  /** Upper bound on items — part of the op's static cost (SPEC-DRAFT §11). */
  max?: number;
}

export const t = {
  string(options: StringOptions = {}): Schema<string> {
    const { min, max, pattern } = options;
    return define(
      'string',
      (value, ctx) => {
        if (typeof value !== 'string') return report(ctx, `expected string, got ${typeOf(value)}`);
        if (min !== undefined && value.length < min) report(ctx, `shorter than ${min}`);
        if (max !== undefined && value.length > max) report(ctx, `longer than ${max}`);
        if (pattern && !pattern.test(value)) report(ctx, `does not match ${pattern}`);
        return value;
      },
      () => ({
        type: 'string',
        ...(min === undefined ? {} : { minLength: min }),
        ...(max === undefined ? {} : { maxLength: max }),
        ...(pattern ? { pattern: pattern.source } : {}),
      }),
    );
  },

  number(options: NumberOptions = {}): Schema<number> {
    const { int, min, max } = options;
    return define(
      int ? 'integer' : 'number',
      (value, ctx) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) return report(ctx, `expected number, got ${typeOf(value)}`);
        if (int && !Number.isInteger(value)) report(ctx, 'expected integer');
        if (min !== undefined && value < min) report(ctx, `less than ${min}`);
        if (max !== undefined && value > max) report(ctx, `greater than ${max}`);
        return value;
      },
      () => ({
        type: int ? 'integer' : 'number',
        ...(min === undefined ? {} : { minimum: min }),
        ...(max === undefined ? {} : { maximum: max }),
      }),
    );
  },

  boolean(): Schema<boolean> {
    return define(
      'boolean',
      (value, ctx) => (typeof value === 'boolean' ? value : report(ctx, `expected boolean, got ${typeOf(value)}`)),
      () => ({ type: 'boolean' }),
    );
  },

  /** String union, e.g. t.enum(['open', 'closed']). (Named `enum` as a property, not TS enum syntax.) */
  enum<const V extends readonly string[]>(values: V): Schema<V[number]> {
    const allowed = new Set<unknown>(values);
    return define(
      'enum',
      (value, ctx) => (allowed.has(value) ? (value as V[number]) : report(ctx, `expected one of ${values.join(', ')}`)),
      () => ({ type: 'string', enum: [...values] }),
    );
  },

  array<T>(item: Schema<T>, options: ArrayOptions = {}): Schema<T[]> {
    const { max } = options;
    return withStructure({ element: item }, define(
      'array',
      (value, ctx) => {
        if (!Array.isArray(value)) return report(ctx, `expected array, got ${typeOf(value)}`);
        if (max !== undefined && value.length > max) return report(ctx, `more than ${max} items`);
        const out = new Array<T>(value.length);
        for (let i = 0; i < value.length; i++) {
          ctx.path.push(i);
          out[i] = item.check(value[i], ctx) as T;
          ctx.path.pop();
        }
        return out;
      },
      () => ({ type: 'array', items: item.toJSONSchema(), ...(max === undefined ? {} : { maxItems: max }) }),
    ));
  },

  object<S extends Shape>(shape: S): Schema<InferShape<S>> {
    // Computed once per schema, not per parse.
    const fields = Object.entries(shape).map(([key, schema]) => ({
      key,
      schema,
      optional: (schema as Partial<OptionalMarker>).optional === true,
    }));
    return withStructure({ fields: shape }, define(
      'object',
      (value, ctx) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return report(ctx, `expected object, got ${typeOf(value)}`);
        }
        const input = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const { key, schema, optional } of fields) {
          const field = input[key];
          ctx.path.push(key);
          if (field === undefined) {
            if (!optional) report(ctx, 'required');
          } else {
            out[key] = schema.check(field, ctx);
          }
          ctx.path.pop();
        }
        // Unknown keys are dropped, not rejected: newer clients may send fields older servers don't know.
        return out as InferShape<S>;
      },
      () => ({
        type: 'object',
        properties: Object.fromEntries(fields.map(({ key, schema }) => [key, schema.toJSONSchema()])),
        required: fields.filter((f) => !f.optional).map((f) => f.key),
      }),
    ));
  },

  optional<T>(schema: Schema<T>): Schema<T | undefined> & OptionalMarker {
    return { ...schema, optional: true };
  },

  nullable<T>(schema: Schema<T>): Schema<T | null> {
    return withStructure(
      { inner: schema },
      define(
        schema.kind,
        (value, ctx) => (value === null ? null : schema.check(value, ctx)),
        () => ({ anyOf: [schema.toJSONSchema(), { type: 'null' }] }),
      ),
    );
  },

  /**
   * Binary data. Travels as raw BLOB frames in framed streams (no base64, chunked); unary ops
   * whose output contains bytes are answered framed as well.
   */
  bytes(options: { max?: number } = {}): Schema<Uint8Array> {
    const { max } = options;
    return define(
      'bytes',
      (value, ctx) => {
        if (!(value instanceof Uint8Array)) return report(ctx, `expected bytes, got ${typeOf(value)}`);
        if (max !== undefined && value.byteLength > max) report(ctx, `more than ${max} bytes`);
        return value;
      },
      () => ({ type: 'string', contentEncoding: 'base64', contentMediaType: 'application/octet-stream', 'x-apue-transfer': 'blob-frames' }),
    );
  },

  unknown(): Schema<unknown> {
    return define('unknown', (value) => value, () => ({}));
  },

  /** No payload (input or output). */
  void(): Schema<void> {
    return define(
      'void',
      (value, ctx) => (value === undefined || value === null ? undefined : report(ctx, 'expected no value')),
      () => ({ type: 'null' }),
    );
  },
};
