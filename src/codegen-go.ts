// Go client generation from a manifest (SPEC-DRAFT §11): one self-contained, gofmt-clean file — the
// runtime (src/go/runtime.go, standard library only) plus the API's types (structs with json tags,
// string types with constants for enums) and one method per op on Client. Node-only (reads the
// runtime template).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schemaCode, type Manifest, type ManifestOp } from './codegen.ts';

type JsonSchema = Record<string, any>;

const RUNTIME = readFileSync(join(import.meta.dirname, 'go', 'runtime.go'), 'utf8');
/** Exported identifiers of the runtime: generated names must not collide with them. */
const RUNTIME_NAMES = new Set([...RUNTIME.matchAll(/^(?:func|type|var|const)\s+([A-Z]\w*)/gm)].map((m) => m[1]!));
/** Methods the runtime defines on Client: an op with such a name gets an `Op` suffix. */
const CLIENT_METHODS = new Set([...RUNTIME.matchAll(/^func \(c \*Client\) ([A-Z]\w*)/gm)].map((m) => m[1]!));
const KEYWORDS = new Set(['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var']);

export interface GoOptions {
  /** Where the manifest came from (for the header comment). */
  source?: string;
  /** Go package name of the generated file. Default `api`. */
  packageName?: string;
}

/** `users.get` → `UsersGet`; `3d.render` → `Op3dRender`. */
function pascal(text: string): string {
  return text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join('');
}

/** The exported Go method name for an op (`users.get` → `UsersGet`; `close` → `CloseOp`). */
export function goName(opName: string): string {
  let name = pascal(opName);
  if (!/^[A-Z]/.test(name)) name = `Op${name}`;
  return CLIENT_METHODS.has(name) ? `${name}Op` : name;
}

/** A Go interpreted string literal (UTF-8 source; control characters and quotes escaped). */
export function goString(text: string): string {
  let out = '"';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"' || ch === '\\') out += `\\${ch}`;
    else if (cp >= 0xd800 && cp <= 0xdfff) throw new Error(`a lone surrogate can't be written in Go source: ${JSON.stringify(text).slice(0, 60)}`);
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, '0')}`;
    else if (cp === 0xfeff) out += '\\ufeff'; // a BOM is only allowed at the start of a Go file
    else out += ch;
  }
  return `${out}"`;
}

/**
 * encoding/json ignores a struct tag name with other characters (and then uses the Go field name),
 * so such keys can't be expressed with json tags (same rule as encoding/json's isValidTag).
 */
const VALID_TAG = /^[\p{L}\p{Nd}!#$%&()*+\-./:;<=>?@[\]^_{|}~ ]+$/u;

interface GoType {
  code: string;
  /** Has a nil value of its own (pointer, slice, any): nullable/optional needs no extra pointer. */
  nilable: boolean;
}

export function generateGo(manifest: Manifest, options: GoOptions = {}): string {
  const pkg = options.packageName ?? 'api';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pkg) || pkg === '_' || KEYWORDS.has(pkg)) throw new Error(`--package: not a valid Go package name: ${pkg}`);
  const taken = new Set(RUNTIME_NAMES);
  const unique = (base: string): string => {
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
    taken.add(name);
    return name;
  };
  const declarations: string[] = [];

  /** Go type for a schema position; objects and enums become named types called `name`. */
  function goType(schema: JsonSchema, name: string, where: string, top: boolean): GoType {
    const fail = (why: string) => new Error(`unsupported JSON Schema for Go (${where}): ${why}: ${JSON.stringify(schema).slice(0, 120)}`);
    if (Object.keys(schema).length === 0) return { code: 'any', nilable: true };
    if (Array.isArray(schema.anyOf)) {
      const branches = schema.anyOf.filter((b: JsonSchema) => b.type !== 'null');
      if (branches.length !== 1 || schema.anyOf.length !== 2) throw fail('only T | null unions can be expressed');
      const inner = goType(branches[0], name, where, top);
      return inner.nilable ? inner : { code: `*${inner.code}`, nilable: true };
    }
    switch (schema.type) {
      case 'null':
        throw fail('a value that can only be null');
      case 'boolean':
        return { code: 'bool', nilable: false };
      case 'integer':
        return { code: 'int64', nilable: false };
      case 'number':
        return { code: 'float64', nilable: false };
      case 'string':
        if (schema['x-apue-transfer'] === 'blob-frames') return { code: '[]byte', nilable: true };
        if (schema['x-apue-transfer'] === 'upload') {
          if (!where.endsWith('input')) throw fail('t.file() outside an input');
          return { code: 'File', nilable: false };
        }
        if (Array.isArray(schema.enum)) return { code: enumType(schema.enum, name, where, top), nilable: false };
        return { code: 'string', nilable: false };
      case 'array':
        return { code: `[]${goType(schema.items ?? {}, `${name}Item`, where, false).code}`, nilable: true };
      case 'object':
        if (schema['x-apue-transfer'] === 'download') {
          if (!where.endsWith('output')) throw fail('t.download() outside an output');
          return { code: 'Download', nilable: false };
        }
        return { code: structType(schema, name, where, top), nilable: false };
      default:
        throw fail('unknown type');
    }
  }

  function doc(typeName: string, where: string, top: boolean): string {
    return `// ${typeName} is ${top ? 'the' : 'part of the'} ${where}.`;
  }

  function enumType(values: unknown[], base: string, where: string, top: boolean): string {
    const typeName = unique(base);
    if (!values.every((v) => typeof v === 'string')) throw new Error(`unsupported JSON Schema for Go (${where}): non-string enum`);
    const consts = (values as string[]).map((value) => [unique(`${typeName}${pascal(value) || 'Empty'}`), value] as const);
    const width = Math.max(...consts.map(([n]) => n.length));
    declarations.push(
      [doc(typeName, where, top), `type ${typeName} string`, '', 'const (', ...consts.map(([n, v]) => `\t${n.padEnd(width)} ${typeName} = ${goString(v)}`), ')'].join('\n'),
    );
    return typeName;
  }

  function structType(schema: JsonSchema, base: string, where: string, top: boolean): string {
    const typeName = unique(base);
    const required = new Set<string>(schema.required ?? []);
    const fieldNames = new Set<string>();
    const fields = Object.entries<JsonSchema>(schema.properties ?? {}).map(([key, value]) => {
      if (!VALID_TAG.test(key)) throw new Error(`unsupported JSON Schema for Go (${where}): property name ${JSON.stringify(key)} can't be a json struct tag`);
      let field = pascal(key);
      if (!/^[A-Z]/.test(field)) field = `X${field}`;
      for (let i = 2, b = field; fieldNames.has(field); i++) field = `${b}${i}`;
      fieldNames.add(field);
      const type = goType(value, `${typeName}${field}`, where, false);
      const tagName = key === '-' ? '-,' : key; // "-" alone means "skip this field"
      if (required.has(key)) return [field, type.code, `\`json:"${tagName}"\``] as const;
      const sep = tagName.endsWith(',') ? '' : ',';
      // Optional: nil leaves the member out. Slices use omitzero so an empty array is still sent.
      if (type.code.startsWith('[]')) return [field, type.code, `\`json:"${tagName}${sep}omitzero"\``] as const;
      return [field, type.nilable ? type.code : `*${type.code}`, `\`json:"${tagName}${sep}omitempty"\``] as const;
    });
    const nameWidth = Math.max(0, ...fields.map(([n]) => n.length));
    const typeWidth = Math.max(0, ...fields.map(([, t]) => t.length));
    const body = fields.map(([n, t, tag]) => `\t${n.padEnd(nameWidth)} ${t.padEnd(typeWidth)} ${tag}`);
    declarations.push([doc(typeName, where, top), body.length ? `type ${typeName} struct {\n${body.join('\n')}\n}` : `type ${typeName} struct{}`].join('\n'));
    return typeName;
  }

  /** Top-level input/output: void (null) is undefined for unary calls, `*struct{}` in streams. */
  function topType(schema: JsonSchema, name: string, where: string, stream: boolean): string | undefined {
    if (schema.type === 'null' && Object.keys(schema).length === 1) return stream ? '*struct{}' : undefined;
    return goType(schema, name, where, true).code;
  }

  const methods: string[] = [];
  const methodNames = new Set<string>();
  const ops = Object.entries(manifest.ops);
  for (const [op, def] of ops) {
    // The same keyword whitelist as the TypeScript generator: unknown keywords are refused.
    schemaCode(def.input);
    schemaCode(def.output);
    let method = goName(op);
    for (let i = 2, base = method; methodNames.has(method) || CLIENT_METHODS.has(method); i++) method = `${base}${i}`;
    methodNames.add(method);
    const isStream = def.stream !== 'none';
    const input = topType(def.input, `${method}Input`, `${op} input`, def.stream === 'client' || def.stream === 'bidi');
    const output = topType(def.output, `${method}Output`, `${op} output`, isStream);
    methods.push(methodCode(op, def, method, input, output));
  }

  const meta = Object.fromEntries(ops.map(([op, def]) => [op, { effect: def.effect, stream: def.stream, input: def.input, output: def.output }]));
  const header = `// Code generated by apue-types --lang go${options.source ? ` from ${options.source.replace(/[\r\n]/g, ' ')}` : ''} (manifest ${manifest.apue}). DO NOT EDIT.`;
  return [
    header,
    '',
    RUNTIME.replace(/^package apue$/m, `package ${pkg}`).trimEnd(),
    '',
    '// ---- generated from the manifest --------------------------------------------------------------',
    '',
    'func init() {',
    `\tregisterOps(${goString(JSON.stringify(meta))})`,
    '}',
    '',
    ...declarations.flatMap((d) => [d, '']),
    ...methods.flatMap((m, i) => (i === methods.length - 1 ? [m] : [m, ''])),
  ].join('\n') + '\n';
}

function methodCode(op: string, def: ManifestOp, method: string, input: string | undefined, output: string | undefined): string {
  const kind = def.stream === 'none' ? def.effect : `${def.effect}, ${def.stream} stream`;
  const lines = [`// ${method} calls ${op} (${kind}).${def.description ? ` ${def.description.replace(/\s+/g, ' ').trim()}` : ''}`];
  if (def.deprecated) {
    lines.push('//', `// Deprecated: since ${def.deprecated.since}${def.deprecated.sunset ? `, sunset ${def.deprecated.sunset}` : ''}${def.deprecated.link ? ` (${def.deprecated.link})` : ''}.`);
  }
  const name = goString(op);
  const param = input === undefined ? '' : `, in ${input}`;
  const arg = input === undefined ? 'noInput{}' : 'in';
  switch (def.stream) {
    case 'server':
      lines.push(
        `func (c *Client) ${method}(ctx context.Context${param}, opts ...CallOption) (*ServerStream[${output}], error) {`,
        `\treturn serverStream[${output}](ctx, c, ${name}, ${arg}, opts)`,
      );
      break;
    case 'client':
      lines.push(
        `func (c *Client) ${method}(ctx context.Context, opts ...CallOption) (*ClientStream[${input}, ${output}], error) {`,
        `\treturn openClientStream[${input}, ${output}](ctx, c, ${name}, opts)`,
      );
      break;
    case 'bidi':
      lines.push(
        `func (c *Client) ${method}(ctx context.Context, opts ...CallOption) (*BidiStream[${input}, ${output}], error) {`,
        `\treturn openBidiStream[${input}, ${output}](ctx, c, ${name}, opts)`,
      );
      break;
    default:
      if (output === undefined) {
        lines.push(
          `func (c *Client) ${method}(ctx context.Context${param}, opts ...CallOption) error {`,
          `\t_, err := unary[struct{}](ctx, c, ${name}, ${arg}, opts)`,
          '\treturn err',
        );
      } else {
        lines.push(`func (c *Client) ${method}(ctx context.Context${param}, opts ...CallOption) (${output}, error) {`, `\treturn unary[${output}](ctx, c, ${name}, ${arg}, opts)`);
      }
  }
  lines.push('}');
  return lines.join('\n');
}
