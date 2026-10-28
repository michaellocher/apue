// Swift client generation from a manifest (SPEC-DRAFT §11): one self-contained source file — the
// runtime (src/swift/Runtime.swift, Foundation only) plus the API's types (Codable structs, String
// enums) and a Client struct with one async method per op. Node-only (reads the runtime template).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schemaCode, type Manifest } from './codegen.ts';

type JsonSchema = Record<string, any>;

const RUNTIME = readFileSync(join(import.meta.dirname, 'swift', 'Runtime.swift'), 'utf8');

// Reserved words (The Swift Programming Language, "Lexical Structure"): escaped with backticks.
const KEYWORDS = new Set([
  'associatedtype', 'borrowing', 'class', 'consuming', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import', 'init', 'inout', 'internal',
  'let', 'nonisolated', 'open', 'operator', 'private', 'precedencegroup', 'protocol', 'public', 'rethrows', 'static', 'struct', 'subscript',
  'typealias', 'var', 'break', 'case', 'catch', 'continue', 'default', 'defer', 'do', 'else', 'fallthrough', 'for', 'guard', 'if', 'in',
  'repeat', 'return', 'throw', 'switch', 'where', 'while', 'Any', 'as', 'await', 'false', 'is', 'nil', 'self', 'Self', 'super', 'throws',
  'true', 'try', 'async', 'some', 'any',
]);
// Names that even backticks don't make usable as members (or that clash with what the generated
// types already have): an underscore is appended instead.
const RESERVED = new Set(['self', 'Self', 'init', 'deinit', 'subscript', 'Type', 'Protocol', 'super', 'runtime', 'rawValue', 'allCases', 'hashValue']);

/** A Swift identifier from arbitrary text: `odd-key` → `oddKey`, keywords escaped. */
function identifier(text: string): string {
  const words = text.split(/[^A-Za-z0-9_]+/).filter(Boolean);
  let name = words.map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1))).join('');
  if (name === '') name = '_';
  if (/^\d/.test(name)) name = `_${name}`;
  if (RESERVED.has(name)) return `${name}_`;
  return KEYWORDS.has(name) ? `\`${name}\`` : name;
}

/** `users.get` → `usersGet` (a valid Swift method name; keywords in backticks). */
export function swiftName(opName: string): string {
  const name = identifier(opName);
  return name.startsWith('`') ? name : name[0]!.toLowerCase() + name.slice(1);
}

/** `users.get` + `Input` → `UsersGetInput`. */
function typeName(...parts: string[]): string {
  const name = parts.map((part) => part.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('')).join('');
  return /^\d/.test(name) ? `_${name}` : name || 'Value';
}

const str = (text: string) => JSON.stringify(text).replace(/\\u([0-9a-f]{4})/g, '\\u{$1}'); // a Swift string literal

/** Whether a schema has `x-apue-transfer` of one of the kinds anywhere. */
function transfers(schema: unknown, kinds: string[]): boolean {
  if (Array.isArray(schema)) return schema.some((s) => transfers(s, kinds));
  if (schema === null || typeof schema !== 'object') return false;
  const record = schema as JsonSchema;
  if (kinds.includes(record['x-apue-transfer'])) return true;
  return Object.values(record).some((v) => transfers(v, kinds));
}

/** Makes `name` unique within `taken` by appending underscores (inside backticks if any). */
function unique(name: string, taken: Set<string>): string {
  let candidate = name;
  while (taken.has(candidate.replace(/`/g, ''))) candidate = candidate.startsWith('`') ? `${candidate.slice(0, -1)}_\`` : `${candidate}_`;
  taken.add(candidate.replace(/`/g, ''));
  return candidate;
}

interface Shape {
  /** The Swift type of a non-null value. */
  type: string;
  nullable: boolean;
  /** t.unknown(): JSONValue already holds null, absent is decoded as .null. */
  unknown: boolean;
}

export function generateSwift(manifest: Manifest, options: { source?: string } = {}): string {
  const declarations: string[] = [];
  const typeNames = new Set<string>();

  /** The Swift shape of a schema; objects and enums are declared under `name` (made unique). */
  function shape(schema: JsonSchema, name: string): Shape {
    if (Object.keys(schema).length === 0) return { type: 'JSONValue', nullable: false, unknown: true };
    if (Array.isArray(schema.anyOf)) {
      // schemaCode() has checked the form: anyOf [inner, {type: null}] (t.nullable).
      const inner = shape(schema.anyOf[0], name);
      return inner.unknown ? inner : { ...inner, nullable: true };
    }
    switch (schema.type) {
      case 'null':
        return { type: 'JSONValue', nullable: false, unknown: true };
      case 'boolean':
        return plain('Bool');
      case 'integer':
        return plain('Int');
      case 'number':
        return plain('Double');
      case 'string':
        if (schema['x-apue-transfer'] === 'blob-frames') return plain('Data');
        if (schema['x-apue-transfer'] === 'upload') return plain('ApueFile');
        if (Array.isArray(schema.enum)) return plain(declareEnum(schema.enum, name));
        return plain('String');
      case 'array': {
        const item = shape(schema.items ?? {}, `${name}Item`);
        return plain(`[${item.type}${item.nullable ? '?' : ''}]`);
      }
      case 'object':
        if (schema['x-apue-transfer'] === 'download') return plain('Download');
        return plain(declareStruct(schema, name));
      default:
        throw new Error(`unsupported JSON Schema: ${JSON.stringify(schema).slice(0, 120)}`);
    }
  }

  function plain(type: string): Shape {
    return { type, nullable: false, unknown: false };
  }

  function declareEnum(values: string[], name: string): string {
    const type = unique(name, typeNames);
    const taken = new Set<string>();
    const cases = values.map((value) => `  case ${unique(swiftName(value), taken)} = ${str(value)}`);
    declarations.push(`public enum ${type}: String, Codable, Sendable, CaseIterable {\n${cases.join('\n')}\n}`);
    return type;
  }

  function declareStruct(schema: JsonSchema, name: string): string {
    const type = unique(name, typeNames);
    const required = new Set<string>(schema.required ?? []);
    const taken = new Set<string>();
    const fields = Object.entries<JsonSchema>(schema.properties ?? {}).map(([key, sub], index) => {
      const s = shape(sub, typeName(type, key));
      const isRequired = required.has(key);
      // Absent vs null: required nullable → T? (nil encodes as null); optional → T? (nil = absent);
      // optional nullable → T?? (nil = absent, .some(nil) = null); t.unknown() → JSONValue (.null).
      const swiftType = s.unknown ? (isRequired ? 'JSONValue' : 'JSONValue?') : s.nullable ? (isRequired ? `${s.type}?` : `${s.type}??`) : isRequired ? s.type : `${s.type}?`;
      return { key, name: unique(identifier(key), taken), codingKey: `k${index}`, s, isRequired, swiftType };
    });
    const lines = [`public struct ${type}: Codable, Sendable {`];
    for (const f of fields) lines.push(`  public var ${f.name}: ${f.swiftType}`);
    const params = fields.map((f) => `${f.name}: ${f.swiftType}${f.swiftType.endsWith('?') && !(f.isRequired && f.s.nullable) ? ' = nil' : ''}`);
    if (fields.length > 0) lines.push('');
    lines.push(`  public init(${params.join(', ')}) {${fields.length ? '' : '}'}`, ...fields.map((f) => `    self.${f.name} = ${f.name}`), ...(fields.length ? ['  }'] : []));
    if (fields.length === 0) {
      lines.push('', '  public init(from decoder: Decoder) throws {', '    _ = try decoder.container(keyedBy: ApueKey.self)', '  }');
      lines.push('', '  public func encode(to encoder: Encoder) throws {', '    _ = encoder.container(keyedBy: ApueKey.self)', '  }');
    } else {
      lines.push('', `  private enum Keys: String, CodingKey {`, `    case ${fields.map((f) => `${f.codingKey} = ${str(f.key)}`).join(', ')}`, '  }');
      lines.push('', '  public init(from decoder: Decoder) throws {', '    let container = try decoder.container(keyedBy: Keys.self)');
      for (const f of fields) {
        const self = `self.${f.name}`;
        const k = `.${f.codingKey}`;
        const c = 'container';
        if (f.s.unknown) lines.push(f.isRequired ? `    ${self} = try ${c}.decodeIfPresent(JSONValue.self, forKey: ${k}) ?? .null` : `    ${self} = try ${c}.contains(${k}) ? ${c}.decode(JSONValue.self, forKey: ${k}) : nil`);
        else if (f.s.nullable && !f.isRequired) lines.push(`    ${self} = try ${c}.contains(${k}) ? .some(${c}.decode(${f.s.type}?.self, forKey: ${k})) : nil`);
        else if (f.s.nullable) lines.push(`    ${self} = try ${c}.decode(${f.s.type}?.self, forKey: ${k})`);
        else if (!f.isRequired) lines.push(`    ${self} = try ${c}.decodeIfPresent(${f.s.type}.self, forKey: ${k})`);
        else lines.push(`    ${self} = try ${c}.decode(${f.s.type}.self, forKey: ${k})`);
      }
      lines.push('  }', '', '  public func encode(to encoder: Encoder) throws {', '    var container = encoder.container(keyedBy: Keys.self)');
      for (const f of fields) {
        const k = `.${f.codingKey}`;
        if (f.isRequired) lines.push(`    try container.encode(self.${f.name}, forKey: ${k})`);
        else if (f.s.nullable) lines.push(`    if let value = self.${f.name} { try container.encode(value, forKey: ${k}) }`);
        else lines.push(`    try container.encodeIfPresent(self.${f.name}, forKey: ${k})`);
      }
      lines.push('  }');
    }
    lines.push('}');
    declarations.push(lines.join('\n'));
    return type;
  }

  /** Swift type of a whole input/output (void → undefined). */
  function topLevel(schema: JsonSchema, name: string): string | undefined {
    if (schema.type === 'null' && Object.keys(schema).length === 1) return undefined;
    const s = shape(schema, name);
    return s.nullable ? `${s.type}?` : s.type;
  }

  const methodNames = new Set<string>();
  const methods = Object.entries(manifest.ops).map(([op, def]) => {
    // Reject what the schema builder can't have emitted, like the TypeScript generator does.
    schemaCode(def.input);
    schemaCode(def.output);
    const method = unique(swiftName(op), methodNames);
    const input = topLevel(def.input, typeName(op, 'Input'));
    const output = topLevel(def.output, typeName(op, 'Output'));
    const descriptor = `ApueOp(${str(op)}, .${def.effect}, .${def.stream}, inputBytes: ${transfers(def.input, ['blob-frames', 'upload'])}, outputBytes: ${transfers(def.output, ['blob-frames'])})`;
    const doc = def.description ? def.description.split('\n').map((line) => `  /// ${line}`).join('\n') + '\n' : '';
    const encoded = input ? 'try ApueClient.encode(input)' : 'nil';
    const result = output ?? 'Void';
    const element = output ?? 'JSONValue';
    switch (def.stream) {
      case 'server':
        return `${doc}  public func ${method}(${input ? `_ input: ${input}, ` : ''}timeoutMs: Int? = nil) -> AsyncThrowingStream<${element}, Error> {\n    runtime.serverStream(${descriptor}, Result { ${encoded} }, timeoutMs: timeoutMs)\n  }`;
      case 'client':
        return `${doc}  public func ${method}<S: AsyncSequence & Sendable>(_ inputs: S, timeoutMs: Int? = nil) async throws -> ${result} where S.Element == ${input ?? 'JSONValue'} {\n    ${output ? '' : 'let _: JSONValue = '}try await runtime.clientStream(${descriptor}, inputs, timeoutMs: timeoutMs)\n  }`;
      case 'bidi':
        return `${doc}  /// Full duplex over HTTP/2 (outputs arrive while inputs are still being sent).\n  public func ${method}<S: AsyncSequence & Sendable>(_ inputs: S, timeoutMs: Int? = nil) -> AsyncThrowingStream<${element}, Error> where S.Element == ${input ?? 'JSONValue'} {\n    runtime.requestStream(${descriptor}, inputs, timeoutMs: timeoutMs)\n  }`;
      default: {
        const key = def.effect === 'safe' ? '' : ', idempotencyKey: String? = nil';
        return `${doc}  public func ${method}(${input ? `_ input: ${input}, ` : ''}timeoutMs: Int? = nil${key}) async throws -> ${result} {\n    ${output ? '' : 'let _: JSONValue = '}try await runtime.call(${descriptor}, ${encoded}, timeoutMs: timeoutMs, idempotencyKey: ${def.effect === 'safe' ? 'nil' : 'idempotencyKey'})\n  }`;
      }
    }
  });
  return [
    `// Generated by apue-types --lang swift${options.source ? ` from ${options.source}` : ''} (manifest ${manifest.apue}). Do not edit.`,
    RUNTIME,
    '// MARK: - Generated from the manifest',
    '',
    ...declarations.flatMap((d) => [d, '']),
    '/// The API: one method per op. Thread-safe; share one instance.',
    'public struct Client: Sendable {',
    '  public let runtime: ApueClient',
    '',
    '  public init(baseURL: URL, options: ApueClient.Options = .init()) throws {',
    '    runtime = try ApueClient(baseURL: baseURL, options: options)',
    '  }',
    '',
    '  public init(runtime: ApueClient) {',
    '    self.runtime = runtime',
    '  }',
    '',
    methods.join('\n\n'),
    '}',
    '',
  ].join('\n');
}
