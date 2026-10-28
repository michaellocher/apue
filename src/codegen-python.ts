// Python client generation from a manifest (SPEC-DRAFT §11): one self-contained module — the runtime
// (src/python/runtime.py, standard library only) plus the API's types (TypedDicts) and a Client class
// with one method per op. Node-only (reads the runtime template).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from './codegen.ts';

type JsonSchema = Record<string, any>;

const RUNTIME = readFileSync(join(import.meta.dirname, 'python', 'runtime.py'), 'utf8');
const KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case', 'type']);

/** Public members of the runtime's client and batch classes: an op must not shadow them. */
const MEMBERS = new Set(['OPS', 'authorization', 'backoff', 'base_url', 'batch', 'call', 'close', 'delete_upload', 'retries', 'send', 'stream', 'upload']);

/** `users.get` → `users_get` (a valid Python identifier that is no keyword and no client member). */
export function pythonName(opName: string): string {
  let name = opName.replace(/[^A-Za-z0-9_]/g, '_');
  if (/^\d/.test(name)) name = `_${name}`;
  return KEYWORDS.has(name) || MEMBERS.has(name) ? `${name}_` : name;
}

/** `users.get` + `Input` → `UsersGetInput`. */
function typeName(...parts: string[]): string {
  return parts.map((part) => part.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('')).join('');
}

const pyString = (text: string) => JSON.stringify(text); // a JSON string literal is a valid Python one

export function generatePython(manifest: Manifest, options: { source?: string } = {}): string {
  const declarations: string[] = [];
  const declared = new Map<string, string>(); // type name → its fields

  const methodOps = new Map<string, string>();
  for (const op of Object.keys(manifest.ops)) {
    const other = methodOps.get(pythonName(op));
    if (other !== undefined) throw new Error(`ops ${other} and ${op} would both be the Python method ${pythonName(op)}`);
    methodOps.set(pythonName(op), op);
  }

  /** Python type for a schema; objects become TypedDicts named after their position. */
  function pyType(schema: JsonSchema, name: string): string {
    if (Object.keys(schema).length === 0) return 'Any';
    if (Array.isArray(schema.anyOf)) {
      const branches = schema.anyOf.filter((b: JsonSchema) => b.type !== 'null');
      const nullable = branches.length < schema.anyOf.length;
      const inner = branches.length === 1 ? pyType(branches[0], name) : `Union[${branches.map((b: JsonSchema, i: number) => pyType(b, `${name}${i}`)).join(', ')}]`;
      return nullable ? `Optional[${inner}]` : inner;
    }
    switch (schema.type) {
      case 'null':
        return 'None';
      case 'boolean':
        return 'bool';
      case 'integer':
        return 'int';
      case 'number':
        return 'float';
      case 'string':
        if (schema['x-apue-transfer'] === 'blob-frames') return 'bytes';
        if (schema['x-apue-transfer'] === 'upload') return 'Union[Uploadable, dict]';
        if (Array.isArray(schema.enum)) return `Literal[${schema.enum.map((v: string) => pyString(v)).join(', ')}]`;
        return 'str';
      case 'array':
        return `list[${pyType(schema.items ?? {}, `${name}Item`)}]`;
      case 'object': {
        if (schema['x-apue-transfer'] === 'download') return 'Download';
        const required = new Set<string>(schema.required ?? []);
        const fields = Object.entries<JsonSchema>(schema.properties ?? {}).map(([key, value]) => {
          const type = pyType(value, typeName(name, key));
          return `${pyString(key)}: ${required.has(key) ? type : `NotRequired[${type}]`}`;
        });
        // `users.get` and `usersGet` share a name: a different shape gets a numbered one.
        const body = fields.join(', ');
        let unique = name;
        for (let n = 2; declared.has(unique) && declared.get(unique) !== body; n++) unique = `${name}${n}`;
        if (!declared.has(unique)) {
          declared.set(unique, body);
          // Functional syntax: any key works (dots, dashes, keywords).
          declarations.push(`${unique} = TypedDict(${pyString(unique)}, {${body}})`);
        }
        return unique;
      }
      default:
        return 'Any';
    }
  }

  const ops = Object.entries(manifest.ops);
  const batchMethods: string[] = [];
  const methods = ops.map(([op, def]) => {
    const method = pythonName(op);
    const voidInput = def.input.type === 'null';
    const input = voidInput ? undefined : pyType(def.input, typeName(op, 'Input'));
    const output = def.output.type === 'null' ? 'None' : pyType(def.output, typeName(op, 'Output'));
    const doc = def.description ? `        ${pyString(def.description)}\n` : '';
    const timeout = 'timeout_ms: Optional[int] = None';
    const param = input ? `, input: ${input}` : '';
    const arg = input ? ', input' : '';
    switch (def.stream) {
      case 'server':
        batchMethods.push(`    def ${method}(self${param}) -> BatchStream[${output}]:\n${doc}        return self.stream(${pyString(op)}${arg})\n`);
        return `    def ${method}(self${param}, *, ${timeout}) -> Iterator[${output}]:\n${doc}        return self._stream(${pyString(op)}${arg}, timeout_ms=timeout_ms)\n`;
      case 'client':
        return `    def ${method}(self, inputs: Iterable[${input}], *, ${timeout}) -> ${output}:\n${doc}        return next(iter(self._client_stream(${pyString(op)}, inputs, timeout_ms=timeout_ms)), None)  # type: ignore[return-value]\n`;
      case 'bidi':
        return `    def ${method}(self, inputs: Iterable[${input}], *, ${timeout}) -> Iterator[${output}]:\n        """Half duplex over HTTP/1.1: all inputs are sent before the outputs arrive."""\n        return self._client_stream(${pyString(op)}, inputs, timeout_ms=timeout_ms)\n`;
      default: {
        const safe = def.effect === 'safe';
        const key = safe ? '' : ', idempotency_key: Optional[str] = None';
        const keyArg = safe ? '' : ', idempotency_key=idempotency_key';
        batchMethods.push(`    def ${method}(self${param}${safe ? '' : ', *' + key}) -> BatchCall[${output}]:\n${doc}        return self.call(${pyString(op)}${arg}${keyArg})\n`);
        return `    def ${method}(self${param}, *, ${timeout}${key}) -> ${output}:\n${doc}        return self._call(${pyString(op)}${arg}, timeout_ms=timeout_ms${keyArg})\n`;
      }
    }
  });
  const meta = Object.fromEntries(ops.map(([op, def]) => [op, { effect: def.effect, stream: def.stream, resumable: def.resumable === true, input: def.input, output: def.output }]));
  return [
    `# Generated by apue-types --lang python${options.source ? ` from ${options.source}` : ''} (manifest ${manifest.apue}). Do not edit.`,
    RUNTIME,
    '',
    '# ---- generated from the manifest ----',
    'from typing import Literal, NotRequired, TypedDict  # noqa: E402',
    '',
    ...declarations,
    '',
    '',
    'class Batch(ApueBatchBase):',
    '    """Dependent calls in one round trip: `u = b.users_get(…)`, `b.orders_list({"user": u.ref("id")})`, `b.send()`, `u.result()`."""',
    '',
    ...batchMethods,
    '',
    'class Client(ApueClientBase):',
    `    OPS = json.loads(${pyString(JSON.stringify(meta))})`,
    '',
    '    def batch(self) -> Batch:',
    '        """Starts a pipelined batch (SPEC-DRAFT §10)."""',
    '        return Batch(self)',
    '',
    ...methods,
  ].join('\n');
}
