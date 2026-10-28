// Java client generation from a manifest (SPEC-DRAFT §11): one self-contained source file (Java 17+,
// JDK standard library only) — the runtime (src/java/Runtime.java, nested into the generated class)
// plus the API's types (records, enums) and a Client with one method per op. The output is pure
// ASCII, so it compiles with any default source encoding. Node-only (reads the runtime template).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schemaCode, type Manifest } from './codegen.ts';

type JsonSchema = Record<string, any>;

const TEMPLATE = readFileSync(join(import.meta.dirname, 'java', 'Runtime.java'), 'utf8');
const BEGIN = '// ---- apue runtime: begin ----';
const END = '// ---- apue runtime: end ----';

const KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default', 'do', 'double',
  'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface',
  'long', 'native', 'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch',
  'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null', '_',
  // contextual keywords that are not legal in every position (type names, unqualified calls): never generated
  'var', 'yield', 'record', 'sealed', 'permits',
]);
/** Methods every class has, and the generated records' own. */
const OBJECT_METHODS = ['getClass', 'hashCode', 'equals', 'clone', 'toString', 'notify', 'notifyAll', 'wait', 'finalize'];
const RECORD_RESERVED = new Set([...OBJECT_METHODS, 'toJson', 'fromJson']);
/** The client's own members (src/java/Runtime.java, Base): op methods must not overload them. */
const CLIENT_RESERVED = new Set([
  ...OBJECT_METHODS, 'baseUrl', 'origin', 'close', 'uri', 'request', 'exchange', 'backoffMs', 'pause', 'retryAfterMs', 'send', 'sleepQuietly',
  'upload', 'deleteUpload', 'deleteQuietly', 'withUploads', 'prepare', 'encodeComponent', 'streamRequest', 'retries',
]);
/** java.lang types a nested type must not shadow (the runtime uses them unqualified). */
const JAVA_LANG = [
  'Object', 'String', 'Boolean', 'Byte', 'Character', 'Short', 'Integer', 'Long', 'Float', 'Double', 'Number', 'Void', 'Math', 'System',
  'Thread', 'Runnable', 'Class', 'Enum', 'Record', 'Iterable', 'Comparable', 'CharSequence', 'StringBuilder', 'Throwable', 'Exception',
  'RuntimeException', 'Error', 'IllegalArgumentException', 'IllegalStateException', 'NullPointerException', 'InterruptedException',
  'Override', 'Deprecated', 'SuppressWarnings', 'FunctionalInterface', 'SafeVarargs', 'AutoCloseable', 'Cloneable', 'Process', 'Package', 'Module',
  'ClassLoader', 'Character', 'StackOverflowError', 'ArithmeticException', 'IndexOutOfBoundsException', 'UnsupportedOperationException',
];

const words = (text: string) => text.split(/[^A-Za-z0-9]+/).filter(Boolean);
const upperFirst = (w: string) => w[0]!.toUpperCase() + w.slice(1);
const lowerFirst = (w: string) => w[0]!.toLowerCase() + w.slice(1);

function camel(text: string, fallback: string): string {
  const parts = words(text);
  if (parts.length === 0) return fallback;
  const name = [lowerFirst(parts[0]!), ...parts.slice(1).map(upperFirst)].join('');
  return /^\d/.test(name) ? `_${name}` : name;
}

/** `users.get` → `usersGet` (a valid, non-keyword Java method name; collisions are resolved by the generator). */
export function javaMethodName(opName: string): string {
  const name = camel(opName, 'op');
  return KEYWORDS.has(name) || CLIENT_RESERVED.has(name) ? `${name}_` : name;
}

/** JSON member name → record component name (`odd-key` → `oddKey`, `class` → `class_`). */
export function javaFieldName(key: string): string {
  const name = camel(key, 'value');
  return KEYWORDS.has(name) || RECORD_RESERVED.has(name) ? `${name}_` : name;
}

/** `users.get` + `Input` → `UsersGetInput`. */
function typeName(...parts: string[]): string {
  const name = parts.flatMap(words).map(upperFirst).join('');
  return name === '' ? 'Type' : /^\d/.test(name) ? `T${name}` : name;
}

/** `in-progress` → `IN_PROGRESS`, `camelCase` → `CAMEL_CASE`. */
function constantName(value: string): string {
  const name = words(value.replace(/([a-z0-9])([A-Z])/g, '$1_$2')).map((w) => w.toUpperCase()).join('_');
  return name === '' ? 'EMPTY' : /^\d/.test(name) ? `V${name}` : name;
}

/** A Java string literal: ASCII only (non-ASCII as \uXXXX; never a line terminator as an escape). */
export function javaString(text: string): string {
  let out = '"';
  for (const ch of text) {
    for (let i = 0; i < ch.length; i++) {
      const c = ch.charCodeAt(i);
      if (c === 0x22) out += '\\"';
      else if (c === 0x5c) out += '\\\\';
      else if (c === 0x0a) out += '\\n';
      else if (c === 0x0d) out += '\\r';
      else if (c === 0x09) out += '\\t';
      else if (c < 0x20 || c === 0x7f) out += `\\${c.toString(8).padStart(3, '0')}`;
      else if (c > 0x7e) out += `\\u${c.toString(16).padStart(4, '0')}`;
      else out += String.fromCharCode(c);
    }
  }
  return `${out}"`;
}

/** Text for a comment: ASCII, no comment terminator, no \u escapes, HTML-safe for javadoc. */
function commentText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '&#92;')
    .replace(/\*\//g, '*&#47;')
    .replace(/@/g, '&#64;')
    .replace(/[^\x20-\x7e\n]/gu, (ch) => (ch === '\r' || ch === '\t' ? ' ' : `&#x${ch.codePointAt(0)!.toString(16)};`));
}

function javadoc(indent: string, lines: string[]): string[] {
  const text = lines.flatMap((line) => commentText(line).split('\n'));
  return [`${indent}/**`, ...text.map((line) => `${indent} * ${line}`.trimEnd()), `${indent} */`];
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function transfers(schema: unknown, kinds: string[]): boolean {
  if (Array.isArray(schema)) return schema.some((item) => transfers(item, kinds));
  if (schema === null || typeof schema !== 'object') return false;
  if (kinds.includes((schema as JsonSchema)['x-apue-transfer'])) return true;
  return Object.values(schema).some((value) => transfers(value, kinds));
}

/** A Java type for a schema position and how values convert to and from parsed JSON. */
interface JType {
  /** The type in declarations (may be primitive). */
  decl: string;
  /** The type in generics. */
  boxed: string;
  /** Java expression: the value of `e` (of this type) as JSON (Map/List/String/…; bytes and files stay). */
  enc(e: string, depth: number): string;
  /** Java expression: parsed JSON `e` (an Object) as this type. `$client` is in scope. */
  dec(e: string, depth: number): string;
  /** For nullable types: the non-null type. */
  inner?: JType;
}

export interface JavaOptions {
  /** Where the manifest came from (for the header comment). */
  source?: string;
  /** Java package of the generated file (none: the default package). */
  packageName?: string;
  /** Name of the generated top-level class; the file must be named `<className>.java`. Default `Api`. */
  className?: string;
}

export function generateJava(manifest: Manifest, options: JavaOptions = {}): string {
  const className = options.className ?? 'Api';
  const begin = TEMPLATE.indexOf(BEGIN);
  const end = TEMPLATE.indexOf(END);
  if (begin < 0 || end < begin) throw new Error('src/java/Runtime.java: runtime markers missing');
  const body = TEMPLATE.slice(begin + BEGIN.length, end).replace(/^\n+|\s+$/g, '');
  const imports = TEMPLATE.match(/^import [\w.]+;$/gm) ?? [];
  const preamble = TEMPLATE.slice(0, TEMPLATE.search(/^import /m)).trimEnd();

  // Names a generated type must not take: the runtime's types, imported and java.lang names.
  const taken = new Set<string>([
    'Client', ...JAVA_LANG,
    ...imports.map((line) => line.slice(0, -1).split('.').pop()!),
    ...[...body.matchAll(/\b(?:class|record|interface|enum)\s+([A-Za-z_]\w*)/g)].map((m) => m[1]!),
  ]);
  if (!IDENTIFIER.test(className) || KEYWORDS.has(className) || taken.has(className)) throw new Error(`invalid Java class name: ${className}`);
  const reserved = new Set([...taken, className]);
  if (options.packageName !== undefined && !options.packageName.split('.').every((part) => IDENTIFIER.test(part) && !KEYWORDS.has(part))) {
    throw new Error(`invalid Java package name: ${options.packageName}`);
  }

  const used = new Set(reserved);
  const allocate = (wanted: string): string => {
    let name = wanted;
    for (let i = 2; used.has(name); i++) name = `${wanted}${i}`;
    used.add(name);
    return name;
  };
  const declarations: string[][] = [];

  const lambda = (depth: number) => `$v${depth}`;
  const prim = (decl: string, boxed: string, enc: (e: string) => string, dec: (e: string) => string): JType => ({ decl, boxed, enc: (e) => enc(e), dec: (e) => dec(e) });

  function jtype(schema: JsonSchema, name: string): JType {
    if (Object.keys(schema).length === 0) return prim('Object', 'Object', (e) => `Json.plain(${e})`, (e) => e);
    if (Array.isArray(schema.anyOf)) {
      // schemaCode admits anyOf only as [X, {type: 'null'}] (t.nullable).
      const inner = jtype(schema.anyOf[0], name);
      return {
        decl: inner.boxed,
        boxed: inner.boxed,
        inner,
        enc: (e, d) => `Json.orNull(${e}, ${lambda(d)} -> ${inner.enc(lambda(d), d + 1)})`,
        dec: (e, d) => `Json.orNull(${e}, ${lambda(d)} -> ${inner.dec(lambda(d), d + 1)})`,
      };
    }
    switch (schema.type) {
      case 'null':
        return prim('Void', 'Void', () => 'null', () => 'null');
      case 'boolean':
        return prim('boolean', 'Boolean', (e) => e, (e) => `Json.bool(${e})`);
      case 'integer':
        return prim('long', 'Long', (e) => e, (e) => `Json.int64(${e})`);
      case 'number':
        return prim('double', 'Double', (e) => `Json.finite(${e})`, (e) => `Json.float64(${e})`);
      case 'string':
        if (schema['x-apue-transfer'] === 'blob-frames') return prim('byte[]', 'byte[]', (e) => e, (e) => `Json.bytes(${e})`);
        if (schema['x-apue-transfer'] === 'upload') return prim('FileInput', 'FileInput', (e) => e, (e) => `FileInput.fromJson(${e})`);
        if (Array.isArray(schema.enum)) {
          const type = declareEnum(schema.enum, name);
          return prim(type, type, (e) => `${e}.json()`, (e) => `${type}.fromJson(${e})`);
        }
        return prim('String', 'String', (e) => e, (e) => `Json.string(${e})`);
      case 'array': {
        const item = jtype(schema.items ?? {}, `${name}Item`);
        const type = `List<${item.boxed}>`;
        return {
          decl: type,
          boxed: type,
          enc: (e, d) => `Json.encodeList(${e}, ${lambda(d)} -> ${item.enc(lambda(d), d + 1)})`,
          dec: (e, d) => `Json.decodeList(${e}, ${lambda(d)} -> ${item.dec(lambda(d), d + 1)})`,
        };
      }
      case 'object': {
        if (schema['x-apue-transfer'] === 'download') return prim('Download', 'Download', (e) => `${e}.toJson()`, (e) => `Download.fromJson(${e}, $client)`);
        const type = declareRecord(schema, name);
        return prim(type, type, (e) => `${e}.toJson()`, (e) => `${type}.fromJson(${e}, $client)`);
      }
      default:
        throw new Error(`unsupported JSON Schema: ${JSON.stringify(schema).slice(0, 120)}`);
    }
  }

  function declareEnum(values: string[], wanted: string): string {
    const type = allocate(wanted);
    const constants = new Set<string>();
    const lines = values.map((value, i) => {
      let constant = constantName(value);
      for (let n = 2; constants.has(constant); n++) constant = `${constantName(value)}_${n}`;
      constants.add(constant);
      return `    ${constant}(${javaString(value)})${i === values.length - 1 ? ';' : ','}`;
    });
    declarations.push([
      ...javadoc('  ', [`String enum (the JSON value is json()).`]),
      `  public enum ${type} {`,
      ...(lines.length ? lines : ['    ;']),
      '',
      '    private final String json;',
      '',
      `    ${type}(String json) {`,
      '      this.json = json;',
      '    }',
      '',
      '    /** The value on the wire. */',
      '    public String json() {',
      '      return json;',
      '    }',
      '',
      `    public static ${type} fromJson(Object value) {`,
      `      for (${type} candidate : values()) if (candidate.json.equals(value)) return candidate;`,
      `      throw Json.unexpected(${javaString(`one of ${values.join(', ')}`)}, value);`,
      '    }',
      '  }',
    ]);
    return type;
  }

  function declareRecord(schema: JsonSchema, wanted: string): string {
    const type = allocate(wanted);
    const required = new Set<string>(schema.required ?? []);
    const names = new Set<string>();
    const fields = Object.entries<JsonSchema>(schema.properties ?? {}).map(([key, value]) => {
      let field = javaFieldName(key);
      for (let n = 2; names.has(field); n++) field = `${javaFieldName(key)}${n}`;
      names.add(field);
      const t = jtype(value, typeName(type, key));
      const k = javaString(key);
      if (required.has(key)) {
        // Primitives can't be null; nullable, unknown (Object) and void (Void) members hold JSON null.
        const mayBeNull = (/^[a-z]/.test(t.decl) && !t.decl.endsWith('[]')) || t.inner !== undefined || t.decl === 'Object' || t.decl === 'Void';
        return {
          key, field, required: true, decl: t.decl,
          check: mayBeNull ? undefined : `      Objects.requireNonNull(${field}, ${javaString(field)});`,
          put: `      $m.put(${k}, ${t.enc(field, 0)});`,
          get: t.dec(`Json.required($m, ${k})`, 0),
        };
      }
      if (!t.inner) {
        return {
          key, field, required: false, decl: t.boxed,
          put: `      if (${field} != null) $m.put(${k}, ${t.enc(field, 0)});`,
          get: `Json.optional($m, ${k}, $v0 -> ${t.dec('$v0', 1)})`,
        };
      }
      // Optional and nullable: null = absent, Optional.empty() = JSON null.
      return {
        key, field, required: false, decl: `Optional<${t.boxed}>`,
        put: `      if (${field} != null) $m.put(${k}, ${t.enc(`${field}.orElse(null)`, 0)});`,
        get: `Json.optionalNullable($m, ${k}, $v0 -> ${t.inner.dec('$v0', 1)})`,
      };
    });
    const components = fields.map((f) => `${f.decl} ${f.field}`).join(', ');
    const checks = fields.flatMap((f) => (f.check ? [f.check] : []));
    const requiredOnly = fields.filter((f) => f.required);
    const doc = [
      `JSON object${fields.some((f) => f.field !== f.key) ? ` (members: ${fields.map((f) => (f.field === f.key ? f.key : `${f.field} = "${f.key}"`)).join(', ')})` : ''}.`,
      ...(fields.some((f) => !f.required) ? ['Optional members are null when absent; Optional<...> members are null when absent and empty when null.'] : []),
    ];
    declarations.push([
      ...javadoc('  ', doc),
      `  public record ${type}(${components}) {`,
      ...(checks.length ? [`    public ${type} {`, ...checks, '    }', ''] : []),
      ...(requiredOnly.length < fields.length
        ? [
            '    /** Without the optional members. */',
            `    public ${type}(${requiredOnly.map((f) => `${f.decl} ${f.field}`).join(', ')}) {`,
            `      this(${fields.map((f) => (f.required ? f.field : 'null')).join(', ')});`,
            '    }',
            '',
          ]
        : []),
      '    public Object toJson() {',
      '      Map<String, Object> $m = new LinkedHashMap<>();',
      ...fields.map((f) => f.put),
      '      return $m;',
      '    }',
      '',
      `    public static ${type} fromJson(Object $json, Base $client) {`,
      '      Map<String, Object> $m = Json.object($json);',
      `      return new ${type}(${fields.map((f) => `\n          ${f.get}`).join(',')});`,
      '    }',
      '  }',
    ]);
    return type;
  }

  const methodNames = new Set<string>();
  const opFields: string[] = [];
  const methods: string[][] = [];
  Object.entries(manifest.ops).forEach(([op, def], index) => {
    // The same subset of JSON Schema as the TypeScript generator: anything else is an error, not a weaker type.
    schemaCode(def.input);
    schemaCode(def.output);
    let method = javaMethodName(op);
    for (let n = 2; methodNames.has(method); n++) method = `${javaMethodName(op)}${n}`;
    methodNames.add(method);
    const opField = `$op${index}`;
    const bytesIn = transfers(def.input, ['blob-frames', 'upload']);
    const bytesOut = transfers(def.output, ['blob-frames']);
    opFields.push(`    private static final Op ${opField} = new Op(${javaString(op)}, ${javaString(def.effect)}, ${javaString(def.stream)}, ${bytesIn}, ${bytesOut});`);
    const input = def.input.type === 'null' ? undefined : jtype(def.input, typeName(op, 'Input'));
    const output = def.output.type === 'null' ? undefined : jtype(def.output, typeName(op, 'Output'));
    /** Javadoc: the description (escaped), then the op and notes and tags written here (op names need no escaping). */
    const doc = (extra: string[]) => [
      '    /**',
      ...(def.description ? commentText(def.description).split('\n').map((line) => `     * ${line}`.trimEnd()) : []),
      `     * ${def.description ? '<p>' : ''}Op ${op} (${def.effect}${def.stream === 'none' ? '' : `, ${def.stream} stream`}).`,
      ...extra.map((line) => `     * ${line}`),
      '     */',
    ];
    const deprecated = def.deprecated ? ['    @Deprecated'] : [];
    const encodedInput = input ? input.enc('input', 0) : 'NONE';
    const inParam = input ? `${input.decl} input` : '';
    const inArg = input ? 'input, ' : '';
    const decodeFn = output ? `$v0 -> ${output.dec('$v0', 1)}` : '$v0 -> null';
    const streamType = `Stream<${output ? output.boxed : 'Void'}>`;
    const ret = output ? output.decl : 'void';
    const overload = (signature: string, call: string, returns: boolean) => [
      ...deprecated,
      `    public ${signature} {`,
      `      ${returns ? 'return ' : ''}${call};`,
      '    }',
      '',
    ];
    let lines: string[];
    switch (def.stream) {
      case 'server':
        lines = [
          ...doc(['@return the outputs as they arrive; close it to stop early']),
          ...overload(`${streamType} ${method}(${inParam})`, `${method}(${inArg}CallOptions.DEFAULT)`, true),
          ...doc(['@return the outputs as they arrive; close it to stop early']),
          ...deprecated,
          `    public ${streamType} ${method}(${inParam ? `${inParam}, ` : ''}CallOptions options) {`,
          '      final Base $client = this;',
          `      return $stream(${opField}, ${encodedInput}, options, ${decodeFn});`,
          '    }',
        ];
        break;
      case 'client':
      case 'bidi': {
        const items = `Iterable<${input ? input.boxed : 'Object'}> inputs`;
        const encodeEach = `Json.encodeEach(inputs, $v0 -> ${input ? input.enc('$v0', 1) : 'null'})`;
        const halfDuplex = '<p>Half duplex: the inputs are sent (as they are taken from the Iterable) before outputs can be read.';
        if (def.stream === 'client') {
          const call = `$clientStream(${opField}, ${encodeEach}, options)`;
          lines = [
            ...doc([]),
            ...overload(`${ret} ${method}(${items})`, `${method}(inputs, CallOptions.DEFAULT)`, output !== undefined),
            ...doc([]),
            ...deprecated,
            `    public ${ret} ${method}(${items}, CallOptions options) {`,
            ...(output ? ['      final Base $client = this;', `      return ${output.dec(call, 0)};`] : [`      ${call};`]),
            '    }',
          ];
        } else {
          lines = [
            ...doc([halfDuplex]),
            ...overload(`${streamType} ${method}(${items})`, `${method}(inputs, CallOptions.DEFAULT)`, true),
            ...doc([halfDuplex]),
            ...deprecated,
            `    public ${streamType} ${method}(${items}, CallOptions options) {`,
            '      final Base $client = this;',
            `      return $bidi(${opField}, ${encodeEach}, options, ${decodeFn});`,
            '    }',
          ];
        }
        break;
      }
      default: {
        const call = `$call(${opField}, ${encodedInput}, options)`;
        lines = [
          ...doc([]),
          ...overload(`${ret} ${method}(${inParam})`, `${method}(${inArg}CallOptions.DEFAULT)`, output !== undefined),
          ...doc([]),
          ...deprecated,
          `    public ${ret} ${method}(${inParam ? `${inParam}, ` : ''}CallOptions options) {`,
          ...(output ? ['      final Base $client = this;', `      return ${output.dec(call, 0)};`] : [`      ${call};`]),
          '    }',
        ];
      }
    }
    methods.push(lines);
  });

  const header = commentText(`Generated by apue-types --lang java${options.source ? ` from ${options.source}` : ''} (manifest ${manifest.apue}). Do not edit.`).replace(/\n/g, ' ');
  return [
    `// ${header}`,
    preamble,
    ...(options.packageName ? ['', `package ${options.packageName};`] : []),
    '',
    ...imports,
    '',
    `/** Client for an apue API: the runtime, the API's types and {@link Client}. */`,
    `public final class ${className} {`,
    `  private ${className}() {}`,
    '',
    body,
    '',
    '  // ---- generated from the manifest ----',
    '',
    ...declarations.flatMap((lines) => [...lines, '']),
    '  /** One method per op; each has an overload taking {@link CallOptions} (deadline, Idempotency-Key). */',
    '  public static final class Client extends Base {',
    ...opFields,
    '',
    '    public Client(String baseUrl) {',
    '      this(baseUrl, new Options());',
    '    }',
    '',
    '    public Client(String baseUrl, Options options) {',
    '      super(baseUrl, options);',
    '    }',
    '',
    ...methods.flatMap((lines) => [...lines, '']),
    '  }',
    '}',
    '',
  ].join('\n');
}
