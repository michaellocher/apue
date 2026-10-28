// Minimal TS-first schema builder (SPEC-DRAFT §11): runtime validation + static inference +
// JSON Schema export, from one definition. Web-only, erasable syntax only.

export interface Issue {
  path: string;
  message: string;
}

export class ValidationError extends Error {
  readonly issues: Issue[];

  constructor(issues: Issue[]) {
    super(issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; '));
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

export interface Schema<T> {
  readonly kind: string;
  /** Validates and returns a normalised value (unknown object keys are dropped). */
  parse(value: unknown): T;
  /** Collects issues instead of throwing; returns undefined when invalid. */
  check(value: unknown, path: string, issues: Issue[]): T | undefined;
  toJSONSchema(): Record<string, unknown>;
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
  check: (value: unknown, path: string, issues: Issue[]) => T | undefined,
  jsonSchema: () => Record<string, unknown>,
): Schema<T> {
  return {
    kind,
    check,
    toJSONSchema: jsonSchema,
    parse(value) {
      const issues: Issue[] = [];
      const result = check(value, '', issues);
      if (issues.length > 0) throw new ValidationError(issues);
      return result as T;
    },
  };
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

const join = (path: string, key: string | number) => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key);

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
    return define(
      'string',
      (value, path, issues) => {
        if (typeof value !== 'string') return void issues.push({ path, message: `expected string, got ${typeOf(value)}` });
        if (options.min !== undefined && value.length < options.min) issues.push({ path, message: `shorter than ${options.min}` });
        if (options.max !== undefined && value.length > options.max) issues.push({ path, message: `longer than ${options.max}` });
        if (options.pattern && !options.pattern.test(value)) issues.push({ path, message: `does not match ${options.pattern}` });
        return value;
      },
      () => ({
        type: 'string',
        ...(options.min === undefined ? {} : { minLength: options.min }),
        ...(options.max === undefined ? {} : { maxLength: options.max }),
        ...(options.pattern ? { pattern: options.pattern.source } : {}),
      }),
    );
  },

  number(options: NumberOptions = {}): Schema<number> {
    return define(
      options.int ? 'integer' : 'number',
      (value, path, issues) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) return void issues.push({ path, message: `expected number, got ${typeOf(value)}` });
        if (options.int && !Number.isInteger(value)) issues.push({ path, message: 'expected integer' });
        if (options.min !== undefined && value < options.min) issues.push({ path, message: `less than ${options.min}` });
        if (options.max !== undefined && value > options.max) issues.push({ path, message: `greater than ${options.max}` });
        return value;
      },
      () => ({
        type: options.int ? 'integer' : 'number',
        ...(options.min === undefined ? {} : { minimum: options.min }),
        ...(options.max === undefined ? {} : { maximum: options.max }),
      }),
    );
  },

  boolean(): Schema<boolean> {
    return define(
      'boolean',
      (value, path, issues) => (typeof value === 'boolean' ? value : void issues.push({ path, message: `expected boolean, got ${typeOf(value)}` })),
      () => ({ type: 'boolean' }),
    );
  },

  /** String union, e.g. t.enum(['open', 'closed']). (Named `enum` as a property, not TS enum syntax.) */
  enum<const V extends readonly string[]>(values: V): Schema<V[number]> {
    return define(
      'enum',
      (value, path, issues) =>
        values.includes(value as string) ? (value as V[number]) : void issues.push({ path, message: `expected one of ${values.join(', ')}` }),
      () => ({ type: 'string', enum: [...values] }),
    );
  },

  array<T>(item: Schema<T>, options: ArrayOptions = {}): Schema<T[]> {
    return define(
      'array',
      (value, path, issues) => {
        if (!Array.isArray(value)) return void issues.push({ path, message: `expected array, got ${typeOf(value)}` });
        if (options.max !== undefined && value.length > options.max) {
          return void issues.push({ path, message: `more than ${options.max} items` });
        }
        return value.map((v, i) => item.check(v, join(path, i), issues) as T);
      },
      () => ({ type: 'array', items: item.toJSONSchema(), ...(options.max === undefined ? {} : { maxItems: options.max }) }),
    );
  },

  object<S extends Shape>(shape: S): Schema<InferShape<S>> {
    return define(
      'object',
      (value, path, issues) => {
        if (typeOf(value) !== 'object') return void issues.push({ path, message: `expected object, got ${typeOf(value)}` });
        const input = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [key, schema] of Object.entries(shape)) {
          const field = input[key];
          if (field === undefined) {
            if (!(schema as Partial<OptionalMarker>).optional) issues.push({ path: join(path, key), message: 'required' });
            continue;
          }
          out[key] = schema.check(field, join(path, key), issues);
        }
        // Unknown keys are dropped, not rejected: newer clients may send fields older servers don't know.
        return out as InferShape<S>;
      },
      () => {
        const entries = Object.entries(shape);
        return {
          type: 'object',
          properties: Object.fromEntries(entries.map(([key, schema]) => [key, schema.toJSONSchema()])),
          required: entries.filter(([, schema]) => !(schema as Partial<OptionalMarker>).optional).map(([key]) => key),
        };
      },
    );
  },

  optional<T>(schema: Schema<T>): Schema<T | undefined> & OptionalMarker {
    return { ...schema, optional: true };
  },

  nullable<T>(schema: Schema<T>): Schema<T | null> {
    return define(
      schema.kind,
      (value, path, issues) => (value === null ? null : schema.check(value, path, issues)),
      () => ({ anyOf: [schema.toJSONSchema(), { type: 'null' }] }),
    );
  },

  unknown(): Schema<unknown> {
    return define('unknown', (value) => value, () => ({}));
  },

  /** No payload (input or output). */
  void(): Schema<void> {
    return define(
      'void',
      (value, path, issues) => (value === undefined || value === null ? undefined : void issues.push({ path, message: 'expected no value' })),
      () => ({ type: 'null' }),
    );
  },
};
