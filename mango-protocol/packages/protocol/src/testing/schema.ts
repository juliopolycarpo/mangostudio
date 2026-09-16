/**
 * The normaliser behind this repository's schema-equality check, exported so a
 * consumer that emits its own JSON Schema can compare it against this one by
 * the same rules instead of writing a fourth copy of them.
 *
 * Normaliser rules, the only tolerated differences between emitters:
 * - `$ref` to `#/$defs/<name>` is inlined (sibling keywords kept), as is a
 *   cross-file `other.json#/$defs/<name>` when the caller merged that file in;
 * - `$schema`, `$id`, `title`, `description`, `$comment`, `examples` and
 *   `format` are dropped where they are keywords, never where they are the
 *   *name* of a member (inside `properties`, `patternProperties`,
 *   `dependentSchemas`, `$defs` or `definitions`): `catalog.json` declares a
 *   member called `description`, and dropping it would hide a divergence;
 * - `additionalProperties: true` is dropped (objects are open by default);
 * - a TypeBox `anyOf` whose branches carry distinct `type` consts becomes
 *   `oneOf`;
 * - the `null` alternative schemars adds to `Option` members is stripped
 *   (`type: [T, "null"]` and `anyOf: [T, {type: "null"}]`);
 * - key order is ignored.
 *
 * @example
 * schemaDifferences(normalizeSchema(mine, mineDefs), normalizeSchema(theirs, theirDefs)); // []
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type Definitions = Readonly<Record<string, Json>>;

/** Annotation keywords that carry no validation meaning and differ per emitter. */
const ANNOTATION_KEYS = new Set(['$schema', '$id', 'title', 'description', '$comment', 'examples']);

/** Keys dropped during normalisation. */
const DROPPED_KEYS = new Set([...ANNOTATION_KEYS, 'format']);

/**
 * Keywords whose value maps a *name* to a schema rather than being a schema.
 * Their keys are data — `catalog.json` declares a member literally called
 * `description` — so the rules above must apply to the schemas inside, never
 * to the names holding them. Dropping a name that collides with an annotation
 * keyword would hide a real divergence between two emitters.
 */
const SCHEMA_MAP_KEYS = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
]);

function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * True when every branch is an object schema tagged by a distinct `type` const,
 * the shape of the frame union.
 *
 * @example
 * isConstTaggedUnion([{ type: 'object', properties: { type: { const: 'ping' } } }]); // true
 */
export function isConstTaggedUnion(branches: readonly Json[]): boolean {
  const tags = new Set<string>();
  for (const branch of branches) {
    if (!isObject(branch) || !isObject(branch.properties)) return false;
    const tag = branch.properties.type;
    if (!isObject(tag) || typeof tag.const !== 'string' || tags.has(tag.const)) return false;
    tags.add(tag.const);
  }
  return tags.size > 0;
}

/**
 * Removes the `null` alternative schemars adds to `Option` members; the wire
 * says an optional member is absent, never `null`.
 *
 * @example
 * stripNullAlternative({ type: ['string', 'null'] }); // { type: 'string' }
 */
export function stripNullAlternative(schema: JsonObject): JsonObject {
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((entry) => entry !== 'null');
    return { ...schema, type: types.length === 1 ? (types[0] ?? null) : types };
  }
  const branches = schema.anyOf;
  if (!Array.isArray(branches) || branches.length !== 2) return schema;
  const kept = branches.filter((branch) => !(isObject(branch) && branch.type === 'null'));
  const [only] = kept;
  if (kept.length !== 1 || !isObject(only)) return schema;
  const { anyOf: _anyOf, ...rest } = schema;
  return { ...rest, ...only };
}

/**
 * Resolves `#/$defs/<name>` against the local definitions, and a cross-file
 * reference such as `protocol.json#/$defs/<name>` against a definition keyed
 * by that full reference (the caller merges the other file's `$defs` in under
 * such keys).
 */
function inlineReference(schema: JsonObject, ref: string, definitions: Definitions): JsonObject {
  const target = definitions[ref] ?? definitions[ref.replace(/^#\/\$defs\//, '')];
  if (!isObject(target)) {
    throw new Error(
      `unresolvable $ref ${ref}; expected a #/$defs entry or a merged cross-file key`
    );
  }
  const { $ref: _ref, ...siblings } = schema;
  return { ...target, ...siblings };
}

/**
 * Keys another file's definitions by their cross-file reference, so a
 * document that says `other.json#/$defs/x` can be normalised.
 *
 * @example
 * crossFileDefinitions('protocol.json', spec.$defs); // { 'protocol.json#/$defs/id': …, … }
 */
export function crossFileDefinitions(file: string, definitions: Definitions): Definitions {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, schema]) => [`${file}#/$defs/${name}`, schema])
  );
}

/**
 * Normalises one schema into the comparison form described in the module docs.
 *
 * @example
 * normalizeSchema({ $ref: '#/$defs/id', description: 'x' }, { id: { type: 'string' } });
 * // { type: 'string' }
 */
export function normalizeSchema(schema: Json, definitions: Definitions): Json {
  if (Array.isArray(schema)) return schema.map((entry) => normalizeSchema(entry, definitions));
  if (!isObject(schema)) return schema;
  const stripped = stripNullAlternative(schema);
  if (typeof stripped.$ref === 'string') {
    return normalizeSchema(inlineReference(stripped, stripped.$ref, definitions), definitions);
  }
  const result: JsonObject = {};
  for (const key of Object.keys(stripped).sort()) {
    const value = stripped[key];
    if (value === undefined || DROPPED_KEYS.has(key)) continue;
    if (key === 'additionalProperties' && value === true) continue;
    if (key === 'anyOf' && Array.isArray(value) && isConstTaggedUnion(value)) {
      result.oneOf = normalizeSchema(value, definitions);
      continue;
    }
    if (SCHEMA_MAP_KEYS.has(key) && isObject(value)) {
      result[key] = normalizeSchemaMap(value, definitions);
      continue;
    }
    result[key] = normalizeSchema(value, definitions);
  }
  return result;
}

/**
 * Normalises each schema of a name-to-schema map, leaving every name exactly
 * as it was: a member called `description` or `format` is data, not an
 * annotation this normaliser may drop.
 */
function normalizeSchemaMap(map: JsonObject, definitions: Definitions): JsonObject {
  const result: JsonObject = {};
  for (const name of Object.keys(map).sort()) {
    const member = map[name];
    if (member === undefined) continue;
    result[name] = normalizeSchema(member, definitions);
  }
  return result;
}

function describe(value: Json | undefined): string {
  return JSON.stringify(value);
}

/**
 * Every path where two normalised schemas differ, as JSON pointers with the
 * expected and the received value.
 *
 * @example
 * schemaDifferences({ a: 1 }, { a: 2 }); // ['/a: expected 1, got 2']
 */
export function schemaDifferences(expected: Json, actual: Json, path = ''): string[] {
  const here = path || '/';
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) {
      return [`${here}: expected ${describe(expected)}, got ${describe(actual)}`];
    }
    return expected.flatMap((entry, index) =>
      schemaDifferences(entry, actual[index] ?? null, `${path}/${index}`)
    );
  }
  if (isObject(expected) && isObject(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    return keys.flatMap((key) => {
      const pointer = `${path}/${key}`;
      if (!(key in expected)) return [`${pointer}: unexpected ${describe(actual[key])}`];
      if (!(key in actual)) return [`${pointer}: missing, expected ${describe(expected[key])}`];
      return schemaDifferences(expected[key] ?? null, actual[key] ?? null, pointer);
    });
  }
  if (Object.is(expected, actual)) return [];
  return [`${here}: expected ${describe(expected)}, got ${describe(actual)}`];
}
