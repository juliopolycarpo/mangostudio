/**
 * Whether a runtime peer's answer is "not the schema" or merely "a newer
 * release of it" — the distinction the Hub trust boundary has to make on
 * every result and event it did not shape itself.
 *
 * `RUNTIME_CONTRACT`'s object schemas close with `additionalProperties: false`
 * so `catalog.json` stays exact between two peers on the same release, but a
 * hub and a runtime are allowed to run different releases — every remote
 * transport connects with `requireMatchingRelease: false`, and
 * `runtime-connection-manager.ts`'s `peerRelease` states the policy outright:
 * drift is reported, not refused. An additive field is exactly the shape that
 * drift takes. Treating it as a contract violation would turn a supported
 * deployment into an outage on the runtime's next release; treating a wrong
 * type or a missing required field as anything but a violation would defeat
 * the boundary this module exists for. `checkContractCompatible` draws that
 * line for both a flat object and a schema with unions nested anywhere inside
 * it — `runtime.health` and `probing.agent-clis` both have over a dozen.
 */

import type { TSchema } from 'typebox';
import Value from 'typebox/value';
import { type ContractViolation, describeContractViolation } from './contract-violation';

export type ContractCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly violation: ContractViolation };

const lenientSchemas = new WeakMap<object, TSchema>();

/**
 * `schema`, recursively rewritten so every object it describes — including
 * one nested inside a union branch or an array — accepts a property this copy
 * of the schema does not name. Memoized per schema instance: the same handful
 * of method and event schemas are checked on every call this boundary makes.
 */
function lenientVariantOf(schema: TSchema): TSchema {
  const cached = lenientSchemas.get(schema as object);
  if (cached) return cached;
  const lenient = relaxAdditionalProperties(schema);
  lenientSchemas.set(schema as object, lenient);
  return lenient;
}

/**
 * Descends `anyOf`, `oneOf`, array `items`, and object `properties`. Does not
 * descend `allOf`, a tuple's `items` array, or a `Type.Record`'s value schema
 * (`patternProperties`) — none of `RUNTIME_CONTRACT`'s method or event schemas
 * use the first two, and every current record's value is a scalar with no
 * `additionalProperties` of its own to relax. A future schema that does would
 * need this walk extended before it could tolerate an additive field there.
 */
function relaxAdditionalProperties(schema: TSchema): TSchema {
  const node = schema as Record<string, unknown>;
  if (Array.isArray(node.anyOf)) {
    return {
      ...node,
      anyOf: node.anyOf.map((branch) => relaxAdditionalProperties(branch as TSchema)),
    };
  }
  if (Array.isArray(node.oneOf)) {
    return {
      ...node,
      oneOf: node.oneOf.map((branch) => relaxAdditionalProperties(branch as TSchema)),
    };
  }
  if (node.type === 'array' && node.items) {
    return { ...node, items: relaxAdditionalProperties(node.items as TSchema) };
  }
  if (node.type !== 'object') return schema;
  const properties = node.properties as Record<string, TSchema> | undefined;
  return {
    ...node,
    ...(properties
      ? {
          properties: Object.fromEntries(
            Object.entries(properties).map(([key, value]) => [
              key,
              relaxAdditionalProperties(value),
            ])
          ),
        }
      : {}),
    additionalProperties: true,
  };
}

/**
 * Accepts `value` against `schema` as written, or against the same schema
 * with every object's `additionalProperties` relaxed. A value that only fails
 * because of a property this build's copy of the schema does not know about
 * is a newer peer, not a broken one; a wrong type, a missing required field,
 * or anything else structural still fails under the relaxed schema too, so it
 * is reported as a genuine violation either way.
 *
 * The strict check runs first so a same-release peer — the overwhelming
 * majority of calls — never pays for building the relaxed variant.
 *
 * @example
 * checkContractCompatible(Type.Object({ a: Type.String() }), { a: 'x', b: 1 });
 * // => { ok: true } — `b` is additive, not a violation
 */
export function checkContractCompatible(schema: TSchema, value: unknown): ContractCheckResult {
  if (Value.Check(schema, value) || Value.Check(lenientVariantOf(schema), value)) {
    return { ok: true };
  }
  return { ok: false, violation: describeContractViolation(schema, value) };
}

/**
 * One schema per literal `key` value across a union's branches, read from the
 * union itself so the map can never drift from the branches it mirrors.
 *
 * Skips a branch this cannot read a string literal discriminant from, instead
 * of throwing: a future branch shaped differently — a `Type.Ref`, an
 * intersection — degrades to "not recognized" rather than crashing every
 * import of a module that builds this map at load time.
 *
 * @example
 * const byType = schemaByDiscriminant(ExternalAgentEventSchema, 'type');
 * byType.get('error'); // the 'error' branch's own schema
 */
export function schemaByDiscriminant(union: TSchema, key: string): ReadonlyMap<string, TSchema> {
  const branches = (union as { anyOf?: readonly unknown[] }).anyOf ?? [];
  const entries: [string, TSchema][] = [];
  for (const branch of branches) {
    const properties = (branch as { properties?: Record<string, { const?: unknown }> }).properties;
    const literal = properties?.[key]?.const;
    if (typeof literal === 'string') entries.push([literal, branch as TSchema]);
  }
  return new Map(entries);
}
