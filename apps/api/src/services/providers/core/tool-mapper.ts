/**
 * Shared tool definition mapping helpers.
 *
 * Converts the internal ToolDefinition shape to provider-specific tool schemas.
 * Each provider has slightly different wire formats; this module provides
 * the common conversion primitives.
 */

import type OpenAI from 'openai';
import type { ToolDefinition } from '../types';

/**
 * Converts internal ToolDefinitions to OpenAI Chat Completions tool format.
 * Used by openai-compatible endpoints and the legacy Chat Completions path.
 */
export function toolDefsToChatCompletions(defs: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
  return defs.map((def) => ({
    type: 'function' as const,
    function: {
      name: def.name,
      description: def.description,
      parameters: toPlainJsonSchema(def.parameters),
    },
  }));
}

/**
 * Rewrites a strict-subset schema as plain JSON Schema.
 *
 * Tool `parameters` are stored as plain JSON Schema: a genuine optional is a
 * single `type` omitted from `required`, and length bounds stay on the source.
 * OpenAI Responses cannot consume that shape, so `toStrictSchema` derives the
 * strict dialect at that boundary. This walk is the inverse: `null` dropped
 * from the type union and from `enum`, and the key dropped from `required`.
 *
 * Anthropic, Gemini, and Chat Completions all run it so a leftover
 * strict-dialect schema (an MCP tool authored that way, a test fixture) is
 * still down-converted. Length bounds the strict subset dropped cannot be
 * restored here; they survive only because the source kept them.
 */
export function toPlainJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const plain = plainSchemaNode(schema);
  return isPlainObject(plain) ? plain : schema;
}

/**
 * Derives OpenAI Responses' strict-function dialect from plain JSON Schema.
 *
 * The walk, at every object node (including a type union that contains
 * `'object'`):
 *   - lists every `properties` key in `required`
 *   - widens keys that were not previously required into a nullable type
 *     union (`['string', 'null']`) and into `enum` when one is present
 *   - sets `additionalProperties: false`
 *   - drops `minLength`/`maxLength`, the keywords the strict subset rejects
 *     that still have an executor fallback
 *
 * Composition keywords (`oneOf`, `anyOf`, `allOf`, `not`, `$ref`) are left
 * in place. Dropping them would ship a schema that silently lost its
 * constraint under `strict: true`; leaving them lets `isStrictCompatible`
 * refuse strict mode instead.
 *
 * A `properties` map's keys are argument names, never keywords: a tool may
 * declare an argument called `maxLength` or `not` without losing either.
 */
export function toStrictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const strict = strictSchemaNode(schema);
  return isPlainObject(strict) ? strict : schema;
}

function plainSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(plainSchemaNode);
  if (!isPlainObject(node)) return node;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type') {
      result[key] = withoutNullType(value);
    } else if (key === 'enum' && Array.isArray(value)) {
      const kept = value.filter((entry) => entry !== null);
      result[key] = kept.length > 0 ? kept : value;
    } else if (key === 'properties' && isPlainObject(value)) {
      // Recurse through the map's values, never its keys: those are argument
      // names, and one may collide with a schema keyword.
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, plainSchemaNode(sub)])
      );
    } else {
      result[key] = plainSchemaNode(value);
    }
  }

  const properties = node.properties;
  if (Array.isArray(node.required) && isPlainObject(properties)) {
    result.required = node.required.filter((name) => !isNullableSchema(properties[String(name)]));
  }
  return result;
}

/**
 * Collapses `['string', 'null']` to `'string'`. A union that carries no `null`,
 * or one that would be emptied by the removal, is left as it is.
 */
function withoutNullType(type: unknown): unknown {
  if (!Array.isArray(type)) return type;
  const kept = type.filter((entry) => entry !== 'null');
  if (kept.length === 0) return type;
  return kept.length === 1 ? kept[0] : kept;
}

function isNullableSchema(schema: unknown): boolean {
  return isPlainObject(schema) && Array.isArray(schema.type) && schema.type.includes('null');
}

function strictSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchemaNode);
  if (!isPlainObject(node)) return node;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'minLength' || key === 'maxLength') continue;
    if (key === 'properties' && isPlainObject(value)) {
      // Recurse through the map's values, never its keys: those are argument
      // names, and one may collide with a schema keyword.
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, strictSchemaNode(sub)])
      );
    } else {
      result[key] = strictSchemaNode(value);
    }
  }

  if (!isObjectSchemaType(node.type)) return result;

  result.additionalProperties = false;
  const properties = result.properties;
  if (!isPlainObject(properties)) return result;

  const propertyKeys = Object.keys(properties);
  if (propertyKeys.length === 0) return result;

  const previouslyRequired = new Set(Array.isArray(node.required) ? node.required.map(String) : []);
  const originalRequired = Array.isArray(node.required)
    ? node.required.map(String).filter((name) => name in properties)
    : [];
  const extras = propertyKeys.filter((name) => !previouslyRequired.has(name));
  result.required = [...originalRequired, ...extras];
  result.properties = Object.fromEntries(
    propertyKeys.map((name) => [
      name,
      previouslyRequired.has(name) ? properties[name] : makeNullable(properties[name]),
    ])
  );
  return result;
}

function makeNullable(schema: unknown): unknown {
  if (!isPlainObject(schema)) return schema;
  const result: Record<string, unknown> = { ...schema, type: withNullType(schema.type) };
  if (Array.isArray(schema.enum) && !schema.enum.includes(null)) {
    result.enum = [...schema.enum, null];
  }
  return result;
}

function withNullType(type: unknown): unknown {
  if (type === undefined) return type;
  if (Array.isArray(type)) {
    return type.includes('null') ? type : [...type, 'null'];
  }
  return [type, 'null'];
}

/**
 * Returns true when the given JSON Schema satisfies the subset required by
 * OpenAI Responses' strict function tool mode:
 *   - top-level `type: 'object'`
 *   - `additionalProperties: false`
 *   - every property key appears in `required`, at every nesting depth
 *   - no unsupported keywords (see `UNSUPPORTED_STRICT_KEYWORDS`)
 *
 * An argument that is genuinely optional is expressed in this dialect as a
 * nullable type (`type: ['string', 'null']`) with the key still listed in
 * `required`. That spelling is derived by `toStrictSchema`; source schemas
 * use a real optional. The parsing helpers in `services/tools/arg-parsing`
 * read `null` as absent.
 *
 * Strict is enabled per-tool on the *transformed* schema; tools whose
 * transform cannot satisfy the subset are sent with `strict: false` so
 * validation never blocks the call. Every built-in tool is expected to pass
 * after the transform — a tool that fails should be fixed rather than exempted.
 */
export function isStrictCompatible(schema: Record<string, unknown> | undefined | null): boolean {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.type !== 'object') return false;
  return isStrictNode(schema);
}

/**
 * Applies every strict rule to each schema node reachable from `node`, in one
 * traversal.
 *
 * A nested object with an optional key — or an unsupported keyword buried in
 * one — is rejected by the provider just as a top-level one is, so
 * `ask_user_question`-shaped schemas cannot be validated by inspecting the top
 * level alone.
 */
function isStrictNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return true;
  if (Array.isArray(node)) return node.every(isStrictNode);

  const obj = node as Record<string, unknown>;
  if (UNSUPPORTED_STRICT_KEYWORDS.some((keyword) => keyword in obj)) return false;

  if (isObjectSchemaType(obj.type)) {
    if (obj.additionalProperties !== false) return false;
    const properties = obj.properties;
    if (properties !== undefined) {
      // `typeof [] === 'object'`, and Object.keys on an array is `['0', ...]`,
      // which can vacuously match a `required` list. A properties map has to
      // be a plain object.
      if (!isPlainObject(properties)) return false;
      const required = new Set(Array.isArray(obj.required) ? obj.required : []);
      if (!Object.keys(properties).every((key) => required.has(key))) return false;
    }
  }

  return Object.entries(obj).every(([key, value]) =>
    // A `properties` map is a dictionary of argument names, not a schema: its
    // own keys must not be read as keywords, or a tool that happens to declare
    // an argument called `maxLength` or `not` loses strict mode.
    key === 'properties' && isPlainObject(value)
      ? Object.values(value).every(isStrictNode)
      : isStrictNode(value)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strict object rules apply to `type: 'object'` and to a type union that
 * includes it (`['object', 'null']`). The latter is how an optional nested
 * object is spelled; skipping it would send `additionalProperties: true` or a
 * missing `required` key with `strict: true`.
 */
function isObjectSchemaType(type: unknown): boolean {
  return type === 'object' || (Array.isArray(type) && type.includes('object'));
}

/**
 * Keywords the strict subset rejects outright.
 *
 * `minLength`/`maxLength` are absent from OpenAI's supported-keyword list —
 * only `pattern` and `format` constrain strings there — so a schema carrying
 * them is refused rather than downgraded. `toStrictSchema` drops those two at
 * the Responses boundary; source schemas keep them so Anthropic and Gemini
 * still see the constraint, and the executor continues to enforce it.
 * Numeric `minimum`/`maximum`, `enum`, `pattern` and `minItems`/`maxItems`
 * are supported and stay in the schema.
 */
const UNSUPPORTED_STRICT_KEYWORDS = [
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  '$ref',
  'minLength',
  'maxLength',
] as const;

/**
 * Converts internal ToolDefinitions to the OpenAI Responses API tool format.
 *
 * Each tool's `strict` flag is set individually on the derived schema: tools
 * whose transform satisfies the strict subset get `strict: true` (the model
 * is forced to match the schema exactly); others keep `strict: false` to
 * preserve compatibility.
 */
export function toolDefsToResponsesAPI(defs: ToolDefinition[]): Array<Record<string, unknown>> {
  return defs.map((def) => {
    const parameters = toStrictSchema(def.parameters);
    return {
      type: 'function',
      name: def.name,
      description: def.description,
      parameters,
      strict: isStrictCompatible(parameters),
    };
  });
}

/**
 * Converts internal ToolDefinitions to the Gemini Interactions API tool format.
 *
 * Gemini takes only a subset of OpenAPI, so the schemas are passed through
 * `toPlainJsonSchema` first (a no-op for a plain source, and a down-convert
 * for any leftover strict-dialect schema).
 */
export function toolDefsToGeminiInteractions(
  defs: ToolDefinition[]
): Array<{ type: 'function'; name: string; description: string; parameters: unknown }> {
  return defs.map((def) => ({
    type: 'function' as const,
    name: def.name,
    description: def.description,
    parameters: toPlainJsonSchema(def.parameters),
  }));
}
