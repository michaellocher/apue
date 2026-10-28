// A minimal JSON Schema 2020-12 validator, test-only (no dependency): exactly the keywords used by
// the vendored OpenAPI 3.2 and JSON Schema 2020-12 meta-schemas (test/fixtures/openapi-3.2) and by
// the schemas apü emits. A keyword outside that subset throws instead of being skipped, so nothing
// is silently unchecked. Implemented per draft-bhutton-json-schema-01 (core) and -validation-01:
// $ref/$dynamicRef with the dynamic scope (§8.2.3.2), annotation-based unevaluatedProperties
// (§11.3), `format` and the content keywords as annotations only (format-annotation vocabulary;
// contentSchema is not validated by default, validation §8.2). Limitation: a JSON pointer into a
// resource is resolved against that resource's base URI, without honouring an $id met along the
// pointer's path (none of the vendored schemas needs that).

type Json = any;

const SUBSCHEMA = ['additionalProperties', 'propertyNames', 'items', 'contains', 'if', 'then', 'else', 'not', 'unevaluatedProperties', 'contentSchema'];
const SUBSCHEMA_MAPS = ['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions'];
const SUBSCHEMA_ARRAYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
/** Keywords that only annotate (or identify) — nothing to assert. */
const ANNOTATIONS = new Set([
  '$schema', '$id', '$anchor', '$dynamicAnchor', '$vocabulary', '$comment', '$defs', 'definitions',
  'title', 'description', 'default', 'deprecated', 'readOnly', 'writeOnly', 'examples', 'format',
  'contentEncoding', 'contentMediaType', 'contentSchema',
]);

export interface Result {
  valid: boolean;
  errors: string[];
}

export class SchemaRegistry {
  readonly #resources = new Map<string, Json>();
  readonly #anchors = new Map<string, Json>();
  readonly #dynamicAnchors = new Set<string>();
  readonly #patterns = new Map<string, RegExp>();

  /** Registers a schema (and its embedded resources and anchors) under its $id or `uri`. */
  addSchema(schema: Json, uri?: string): string {
    const base = stripFragment(new URL(schema.$id ?? uri, uri ?? 'urn:apue:anonymous').href);
    this.#resources.set(base, schema);
    this.#walk(schema, base);
    return base;
  }

  /** Registers a non-schema document (e.g. an OpenAPI description) so `#/…` pointers resolve in it. */
  addDocument(document: Json, uri: string): void {
    this.#resources.set(stripFragment(uri), document);
  }

  /** Validates `instance` against the schema at `uri` (a registered resource, optionally `#fragment`). */
  validate(uri: string, instance: Json): Result {
    const target = this.#resolve(uri, uri);
    return this.validateNode(target.node, target.base, instance);
  }

  /** Validates against a schema node inside a registered resource whose base URI is `base`. */
  validateNode(schema: Json, base: string, instance: Json): Result {
    const errors: string[] = [];
    const valid = this.#evaluate(schema, instance, base, [base], '', errors) !== false;
    return { valid, errors: valid ? [] : errors };
  }

  #walk(node: Json, base: string): void {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    if (typeof node.$id === 'string') {
      base = stripFragment(new URL(node.$id, base).href);
      this.#resources.set(base, node);
    }
    if (typeof node.$anchor === 'string') this.#anchors.set(`${base}#${node.$anchor}`, node);
    if (typeof node.$dynamicAnchor === 'string') {
      this.#anchors.set(`${base}#${node.$dynamicAnchor}`, node);
      this.#dynamicAnchors.add(`${base}#${node.$dynamicAnchor}`);
    }
    for (const key of SUBSCHEMA) if (key in node) this.#walk(node[key], base);
    for (const key of SUBSCHEMA_MAPS) if (node[key]) for (const sub of Object.values(node[key])) this.#walk(sub, base);
    for (const key of SUBSCHEMA_ARRAYS) if (Array.isArray(node[key])) for (const sub of node[key]) this.#walk(sub, base);
  }

  #resolve(reference: string, base: string): { node: Json; base: string; fragment: string } {
    const url = new URL(reference, base);
    const fragment = decodeURIComponent(url.hash.slice(1));
    const document = stripFragment(url.href);
    const root = this.#resources.get(document);
    if (root === undefined) throw new Error(`unknown schema resource ${document} (from ${reference})`);
    if (fragment === '') return { node: root, base: document, fragment };
    if (fragment.startsWith('/')) {
      let node = root;
      for (const token of fragment.slice(1).split('/')) {
        const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
        if (node === null || typeof node !== 'object' || !(key in node)) throw new Error(`unresolvable pointer ${reference}`);
        node = node[key];
      }
      return { node, base: document, fragment };
    }
    const node = this.#anchors.get(`${document}#${fragment}`);
    if (node === undefined) throw new Error(`unknown anchor ${reference}`);
    return { node, base: document, fragment };
  }

  #pattern(source: string): RegExp {
    let re = this.#patterns.get(source);
    if (!re) this.#patterns.set(source, (re = new RegExp(source, 'u'))); // ECMA-262 regexes (§6.4)
    return re;
  }

  /**
   * Returns the instance's property names this schema evaluated (for unevaluatedProperties) when
   * valid, false when not. `scope` is the dynamic scope: base URIs of the resources entered.
   */
  #evaluate(schema: Json, instance: Json, base: string, scope: string[], path: string, errors: string[]): Set<string> | false {
    if (schema === true) return new Set();
    if (schema === false) {
      errors.push(`${path || '/'}: false schema`);
      return false;
    }
    if (typeof schema.$id === 'string') {
      base = stripFragment(new URL(schema.$id, base).href);
      if (scope[scope.length - 1] !== base) scope = [...scope, base];
    }
    let valid = true;
    const fail = (message: string) => {
      valid = false;
      errors.push(`${path || '/'}: ${message}`);
    };
    const evaluated = new Set<string>();
    const merge = (result: Set<string> | false) => {
      if (result) for (const name of result) evaluated.add(name);
      return result !== false;
    };
    const sub = (node: Json, value: Json, at: string, into: string[] = errors, nodeBase = base, nodeScope = scope) =>
      this.#evaluate(node, value, nodeBase, nodeScope, at, into);
    const isObject = instance !== null && typeof instance === 'object' && !Array.isArray(instance);

    for (const key of Object.keys(schema)) {
      if (ANNOTATIONS.has(key) || key.startsWith('x-') || KNOWN.has(key)) continue;
      throw new Error(`json-schema.ts: unsupported keyword "${key}" (at ${base})`);
    }

    // References (§8.2.3).
    if (typeof schema.$ref === 'string') {
      const target = this.#resolve(schema.$ref, base);
      const targetScope = scope[scope.length - 1] === target.base ? scope : [...scope, target.base];
      if (!merge(sub(target.node, instance, path, errors, target.base, targetScope))) fail(`$ref ${schema.$ref}`);
    }
    if (typeof schema.$dynamicRef === 'string') {
      let target = this.#resolve(schema.$dynamicRef, base);
      const name = target.fragment;
      // Only a bookend (the initial target declares the dynamic anchor) makes the reference dynamic:
      // then the outermost resource in the dynamic scope with that anchor wins.
      if (name && !name.startsWith('/') && this.#dynamicAnchors.has(`${target.base}#${name}`)) {
        const outermost = scope.find((uri) => this.#dynamicAnchors.has(`${uri}#${name}`));
        if (outermost) target = { node: this.#anchors.get(`${outermost}#${name}`), base: outermost, fragment: name };
      }
      const targetScope = scope[scope.length - 1] === target.base ? scope : [...scope, target.base];
      if (!merge(sub(target.node, instance, path, errors, target.base, targetScope))) fail(`$dynamicRef ${schema.$dynamicRef}`);
    }

    // Validation keywords for any instance type.
    if (schema.type !== undefined) {
      const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((type) => hasType(instance, type))) fail(`type ${types.join('|')}`);
    }
    if (schema.enum !== undefined && !schema.enum.some((value: Json) => deepEqual(value, instance))) fail('enum');
    if ('const' in schema && !deepEqual(schema.const, instance)) fail(`const ${JSON.stringify(schema.const)}`);

    // In-place applicators (§10.2).
    if (schema.allOf) {
      for (const [i, branch] of schema.allOf.entries()) if (!merge(sub(branch, instance, path))) fail(`allOf/${i}`);
    }
    if (schema.anyOf) {
      const branchErrors: string[] = [];
      let matched = 0;
      for (const branch of schema.anyOf) if (merge(sub(branch, instance, path, branchErrors))) matched++; // all branches: annotations from every valid one
      if (matched === 0) fail(`anyOf: no branch matched [${branchErrors.slice(0, 6).join('; ')}]`);
    }
    if (schema.oneOf) {
      const branchErrors: string[] = [];
      const results = schema.oneOf.map((branch: Json) => sub(branch, instance, path, branchErrors));
      const matched = results.filter((r: Set<string> | false) => r !== false);
      if (matched.length !== 1) fail(`oneOf: ${matched.length} branches matched [${branchErrors.slice(0, 6).join('; ')}]`);
      else merge(matched[0]);
    }
    if ('not' in schema && sub(schema.not, instance, path, []) !== false) fail('not');
    if ('if' in schema) {
      const condition = sub(schema.if, instance, path, []);
      if (condition !== false) {
        merge(condition);
        if ('then' in schema && !merge(sub(schema.then, instance, path))) fail('then');
      } else if ('else' in schema && !merge(sub(schema.else, instance, path))) fail('else');
    }

    if (isObject) {
      const names = Object.keys(instance);
      if (schema.required) for (const name of schema.required) if (!(name in instance)) fail(`required "${name}"`);
      if (schema.minProperties !== undefined && names.length < schema.minProperties) fail(`minProperties ${schema.minProperties}`);
      if (schema.maxProperties !== undefined && names.length > schema.maxProperties) fail(`maxProperties ${schema.maxProperties}`);
      if (schema.dependentRequired) {
        for (const [name, needed] of Object.entries<string[]>(schema.dependentRequired)) {
          if (name in instance) for (const other of needed) if (!(other in instance)) fail(`dependentRequired ${name} → ${other}`);
        }
      }
      if (schema.dependentSchemas) {
        for (const [name, dependent] of Object.entries(schema.dependentSchemas)) {
          if (name in instance && !merge(sub(dependent, instance, path))) fail(`dependentSchemas ${name}`);
        }
      }
      if ('propertyNames' in schema) for (const name of names) if (sub(schema.propertyNames, name, `${path}/${name}`) === false) fail(`propertyNames "${name}"`);
      const covered = new Set<string>();
      if (schema.properties) {
        for (const [name, property] of Object.entries(schema.properties)) {
          if (!(name in instance)) continue;
          covered.add(name);
          evaluated.add(name);
          if (sub(property, instance[name], `${path}/${name}`) === false) fail(`properties/${name}`);
        }
      }
      if (schema.patternProperties) {
        for (const [source, property] of Object.entries(schema.patternProperties)) {
          for (const name of names) {
            if (!this.#pattern(source).test(name)) continue;
            covered.add(name);
            evaluated.add(name);
            if (sub(property, instance[name], `${path}/${name}`) === false) fail(`patternProperties ${source}`);
          }
        }
      }
      if ('additionalProperties' in schema) {
        for (const name of names) {
          if (covered.has(name)) continue;
          evaluated.add(name);
          if (sub(schema.additionalProperties, instance[name], `${path}/${name}`) === false) fail(`additionalProperties "${name}"`);
        }
      }
      // Last: needs the annotations of every other keyword and of valid in-place subschemas (§11.3).
      if ('unevaluatedProperties' in schema) {
        for (const name of names) {
          if (evaluated.has(name)) continue;
          if (sub(schema.unevaluatedProperties, instance[name], `${path}/${name}`) === false) fail(`unevaluatedProperties "${name}"`);
          evaluated.add(name);
        }
      }
    }

    if (Array.isArray(instance)) {
      if (schema.minItems !== undefined && instance.length < schema.minItems) fail(`minItems ${schema.minItems}`);
      if (schema.maxItems !== undefined && instance.length > schema.maxItems) fail(`maxItems ${schema.maxItems}`);
      if (schema.uniqueItems && instance.some((a, i) => instance.some((b, j) => j > i && deepEqual(a, b)))) fail('uniqueItems');
      const prefix: Json[] = schema.prefixItems ?? [];
      for (const [i, item] of prefix.entries()) if (i < instance.length && sub(item, instance[i], `${path}/${i}`) === false) fail(`prefixItems/${i}`);
      if ('items' in schema) {
        for (let i = prefix.length; i < instance.length; i++) if (sub(schema.items, instance[i], `${path}/${i}`) === false) fail(`items/${i}`);
      }
      if ('contains' in schema) {
        const count = instance.filter((item, i) => sub(schema.contains, item, `${path}/${i}`, []) !== false).length;
        if (count < (schema.minContains ?? 1)) fail('contains');
        if (schema.maxContains !== undefined && count > schema.maxContains) fail(`maxContains ${schema.maxContains}`);
      }
    }

    if (typeof instance === 'string') {
      const length = [...instance].length; // code points (validation §6.3.1)
      if (schema.minLength !== undefined && length < schema.minLength) fail(`minLength ${schema.minLength}`);
      if (schema.maxLength !== undefined && length > schema.maxLength) fail(`maxLength ${schema.maxLength}`);
      if (schema.pattern !== undefined && !this.#pattern(schema.pattern).test(instance)) fail(`pattern ${schema.pattern}`);
    }

    if (typeof instance === 'number') {
      if (schema.minimum !== undefined && instance < schema.minimum) fail(`minimum ${schema.minimum}`);
      if (schema.maximum !== undefined && instance > schema.maximum) fail(`maximum ${schema.maximum}`);
      if (schema.exclusiveMinimum !== undefined && instance <= schema.exclusiveMinimum) fail(`exclusiveMinimum ${schema.exclusiveMinimum}`);
      if (schema.exclusiveMaximum !== undefined && instance >= schema.exclusiveMaximum) fail(`exclusiveMaximum ${schema.exclusiveMaximum}`);
      if (schema.multipleOf !== undefined && !Number.isInteger(instance / schema.multipleOf)) fail(`multipleOf ${schema.multipleOf}`);
    }

    return valid ? evaluated : false;
  }
}

/** Assertion and applicator keywords implemented above. */
const KNOWN = new Set([
  '$ref', '$dynamicRef', 'type', 'enum', 'const', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else',
  'required', 'minProperties', 'maxProperties', 'dependentRequired', 'dependentSchemas', 'propertyNames',
  'properties', 'patternProperties', 'additionalProperties', 'unevaluatedProperties',
  'minItems', 'maxItems', 'uniqueItems', 'prefixItems', 'items', 'contains', 'minContains', 'maxContains',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
]);

function stripFragment(uri: string): string {
  const at = uri.indexOf('#');
  return at === -1 ? uri : uri.slice(0, at);
}

function hasType(value: Json, type: string): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      throw new Error(`json-schema.ts: unknown type ${type}`);
  }
}

function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}
