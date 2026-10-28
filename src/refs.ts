// Result references for pipelined batches (SPEC-DRAFT §10). Web-only; shared by client and server.
//
// A reference is an object with exactly one member "$ref": [lane, ...path]. Data that would be
// mistaken for a reference (exactly one member named "$ref" or "$lit") is escaped as
// {"$lit": value}; the content of "$lit" is taken verbatim.

export type RefPath = ReadonlyArray<string | number>;

export class RefError extends Error {}

/** Client-side placeholder for "the output (or a field of it) of an earlier call in the batch". */
export class Ref {
  readonly lane: number;
  readonly path: RefPath;

  constructor(lane: number, path: RefPath) {
    this.lane = lane;
    this.path = path;
  }

  toJSON(): { $ref: Array<string | number> } {
    return { $ref: [this.lane, ...this.path] };
  }
}

function soleKey(value: object): string | undefined {
  const keys = Object.keys(value);
  return keys.length === 1 ? keys[0] : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Client: turns Ref instances into wire references and escapes look-alike data. */
export function encodeArgs(value: unknown): unknown {
  if (value instanceof Ref) return value.toJSON();
  if (Array.isArray(value)) return value.map(encodeArgs);
  if (!isPlainObject(value)) return value;
  const key = soleKey(value);
  if (key === '$ref' || key === '$lit') return { $lit: value };
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeArgs(v)]));
}

export function containsRef(value: unknown): boolean {
  if (value instanceof Ref) return true;
  if (Array.isArray(value)) return value.some(containsRef);
  return isPlainObject(value) && Object.values(value).some(containsRef);
}

/** Server: lanes referenced by a call's wire input; validates reference syntax and ordering. */
export function collectRefs(value: unknown, currentLane: number, lanes = new Set<number>()): Set<number> {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, currentLane, lanes);
  } else if (value !== null && typeof value === 'object') {
    const key = soleKey(value);
    if (key === '$lit') return lanes;
    if (key === '$ref') {
      const [lane, ...path] = parseRef((value as { $ref: unknown }).$ref);
      if (lane >= currentLane) throw new RefError(`call ${currentLane} references call ${lane}, which is not earlier in the batch`);
      lanes.add(lane);
      void path;
      return lanes;
    }
    for (const item of Object.values(value)) collectRefs(item, currentLane, lanes);
  }
  return lanes;
}

/** Server: substitutes references with values from earlier outputs and unescapes literals. */
export function resolveRefs(value: unknown, output: (lane: number) => unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, output));
  if (value === null || typeof value !== 'object') return value;
  const key = soleKey(value);
  if (key === '$lit') return (value as { $lit: unknown }).$lit;
  if (key === '$ref') {
    const [lane, ...path] = parseRef((value as { $ref: unknown }).$ref);
    let current = output(lane);
    for (const [depth, segment] of path.entries()) {
      if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
        throw new RefError(`call ${lane} output has no ${path.slice(0, depth + 1).join('.')}`);
      }
      current = (current as Record<string | number, unknown>)[segment];
    }
    return current;
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, output)]));
}

function parseRef(ref: unknown): [number, ...Array<string | number>] {
  if (!Array.isArray(ref) || ref.length === 0) throw new RefError('$ref must be a non-empty array');
  const [lane, ...path] = ref as unknown[];
  if (!Number.isInteger(lane) || (lane as number) < 0) throw new RefError('$ref lane must be a non-negative integer');
  for (const segment of path) {
    const ok = typeof segment === 'string' || (Number.isInteger(segment) && (segment as number) >= 0);
    if (!ok) throw new RefError('$ref path segments must be strings or non-negative integers');
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
      throw new RefError(`$ref path segment ${segment} is not allowed`);
    }
  }
  return [lane as number, ...(path as Array<string | number>)];
}
