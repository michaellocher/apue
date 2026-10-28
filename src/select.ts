// Field selection (SPEC-DRAFT §5): clients ask for a subset of an op's output (`?s=a,b.c`) to
// avoid over-fetching — no query language, validated against the output schema, cost bounded.
// Web-only.
import type { Schema } from './schema.ts';

export class SelectionError extends Error {}

/** Tree of selected fields; `true` selects the whole subtree. */
export type Selection = { [field: string]: Selection | true };

export const MAX_SELECT_PATHS = 64;

/** Parses "a,b.c" into a validated selection tree for `schema`. */
export function compileSelection(schema: Schema<unknown>, spec: string): Selection {
  const paths = spec.split(',').map((p) => p.trim()).filter(Boolean);
  if (paths.length === 0) throw new SelectionError('empty selection');
  if (paths.length > MAX_SELECT_PATHS) throw new SelectionError(`at most ${MAX_SELECT_PATHS} paths`);
  const root: Selection = {};
  for (const path of paths) {
    let node = root;
    let current: Schema<unknown> | undefined = schema;
    const segments = path.split('.');
    for (const [depth, segment] of segments.entries()) {
      current = objectOf(current);
      const field: Schema<unknown> | undefined = current?.fields && Object.hasOwn(current.fields, segment) ? current.fields[segment] : undefined;
      if (!field) throw new SelectionError(`unknown field ${segments.slice(0, depth + 1).join('.')}`);
      current = field;
      if (depth === segments.length - 1) {
        node[segment] = true;
      } else {
        const next = node[segment];
        if (next === true) break; // parent already fully selected
        node = node[segment] = next ?? {};
      }
    }
  }
  return root;
}

/** Applies a selection to an (already validated) value; arrays are projected element-wise. */
export function project(value: unknown, selection: Selection): unknown {
  if (Array.isArray(value)) return value.map((item) => project(item, selection));
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, sub] of Object.entries(selection)) {
    if (!Object.hasOwn(source, key)) continue;
    out[key] = sub === true ? source[key] : project(source[key], sub);
  }
  return out;
}

/** Canonical form for URLs and cache keys: sorted, de-duplicated. */
export function canonicalSelection(paths: readonly string[]): string {
  return [...new Set(paths.map((p) => p.trim()).filter(Boolean))].sort().join(',');
}

/** Top-level fields `?s=` can select (the output is an object, or an array or nullable of one); else undefined. */
export function selectableFields(schema: Schema<unknown>): string[] | undefined {
  const fields = objectOf(schema)?.fields;
  return fields && Object.keys(fields);
}

/** Unwraps arrays, nullable and optional wrappers down to the object schema whose fields we select. */
function objectOf(schema: Schema<unknown> | undefined): Schema<unknown> | undefined {
  let current = schema;
  for (let i = 0; i < 16 && current && !current.fields; i++) current = current.element ?? current.inner;
  return current;
}
