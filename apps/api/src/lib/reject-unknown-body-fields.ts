/**
 * Makes a request body schema reject an unknown field, on Elysia rc.5 and later.
 *
 * Elysia 2.0.0-rc.4 answered a body that a closed object schema
 * (`additionalProperties: false`) rejected with 422. From rc.5 the default
 * `normalize` setting strips what a closed schema rejects and carries on, so a
 * misspelled field became a value silently ignored. Elysia looks for the closed
 * object by testing `additionalProperties === false`, so it never strips under
 * `additionalProperties: Type.Never()`, which TypeBox rejects the same way. This
 * helper rewrites the one into the other, on a copy.
 *
 * Why this and not the alternatives:
 * - `normalize: false` is global and applies to every slot. It also closes open
 *   schemas, rejects unknown query keys and answers a response carrying an
 *   unlisted key with a 500. It cannot be scoped to bodies.
 * - Rewriting the `additionalProperties: false` in `@mangostudio/shared` would
 *   change response schemas too (where stripping is wanted), OpenAPI output and
 *   the frontend's derived types.
 * - A hook that checks the body itself has to read it before Elysia does, in
 *   every parser's own format, and has to reproduce Elysia's coercion.
 *
 * The result is a different object from `schema`, which is left untouched
 * because responses and other consumers reuse it. The type is the input's: the
 * rewrite is a runtime concern, so the inferred body type, and the Eden types
 * the frontend derives from it, do not change.
 *
 * Routes do not call this. `plugins/closed-bodies.ts` applies it to every
 * route's body as the route is compiled, and the test harness applies it to
 * response schemas.
 */

import { type TSchema, Type } from 'typebox';

/** Keywords whose value is a map of name to schema: the keys are data, not keywords. */
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);

/** Keywords whose value is a literal, which may be shaped like a schema without being one. */
const LITERAL_KEYWORDS = new Set(['default', 'const', 'enum', 'examples', 'example']);

function isPlainContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  if (Array.isArray(value)) return true;
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The copies made by one call: a node reused at many places, or a cycle, is copied once. */
type CopyMemo = WeakMap<object, unknown>;

function copyValue(value: unknown, memo: CopyMemo): unknown {
  if (!isPlainContainer(value)) return value;
  const known = memo.get(value);
  if (known !== undefined) return known;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    memo.set(value, copy);
    for (const item of value) copy.push(copyValue(item, memo));
    return copy;
  }
  return copySchemaNode(value, memo);
}

function copySchemaMap(map: Record<string, unknown>, memo: CopyMemo): Record<string, unknown> {
  const known = memo.get(map);
  if (known !== undefined) return known as Record<string, unknown>;
  const copy: Record<string, unknown> = Object.create(Object.getPrototypeOf(map));
  memo.set(map, copy);
  for (const [name, child] of Object.entries(map)) copy[name] = copyValue(child, memo);
  return copy;
}

function copySchemaNode(node: Record<string, unknown>, memo: CopyMemo): Record<string, unknown> {
  const copy: Record<string, unknown> = Object.create(Object.getPrototypeOf(node));
  memo.set(node, copy);

  // Descriptors, not a spread: TypeBox keeps `~kind`, `~optional` and friends as
  // non-enumerable properties, which a spread would drop. Those are copied as
  // they are; only enumerable keywords can hold a nested schema.
  const descriptors = Object.getOwnPropertyDescriptors(node);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === 'additionalProperties' && descriptor.value === false) {
      // Set in the same pass as the others: a descriptor that was frozen on the
      // source (Elysia freezes the schemas it has processed) could not be
      // redefined afterwards.
      descriptor.value = Type.Never();
    } else if (descriptor.enumerable && 'value' in descriptor && !LITERAL_KEYWORDS.has(key)) {
      const value: unknown = descriptor.value;
      descriptor.value =
        SCHEMA_MAP_KEYWORDS.has(key) && isPlainContainer(value) && !Array.isArray(value)
          ? copySchemaMap(value, memo)
          : copyValue(value, memo);
    }
    Object.defineProperty(copy, key, descriptor);
  }
  return copy;
}

/** One copy per schema, so Elysia's validator cache sees the same object every time. */
const rewritten = new WeakMap<object, unknown>();

/**
 * Returns a copy of `schema` in which every object with
 * `additionalProperties: false` has `additionalProperties: Type.Never()`, at any
 * depth: properties, array items, unions, intersections, pattern properties and
 * definitions. Open objects stay open. `schema` itself is not modified.
 */
export function rejectUnknownBodyFields<Schema extends TSchema>(schema: Schema): Schema {
  const known = rewritten.get(schema);
  if (known !== undefined) return known as Schema;
  const copy = copyValue(schema, new WeakMap()) as Schema;
  rewritten.set(schema, copy);
  return copy;
}

/** Whether any object under `schema` is still closed with `additionalProperties: false`. */
export function declaresClosedObject(schema: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof schema !== 'object' || schema === null || seen.has(schema)) return false;
  seen.add(schema);
  if ((schema as { additionalProperties?: unknown }).additionalProperties === false) return true;
  for (const [key, child] of Object.entries(schema)) {
    if (!LITERAL_KEYWORDS.has(key) && declaresClosedObject(child, seen)) return true;
  }
  return false;
}
