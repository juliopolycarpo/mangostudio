/**
 * Reading `RUNTIME_CONTRACT`'s schemas the way the hub trust boundary needs
 * to: a strict check with a bounded diagnostic on failure, and a way to pick
 * one branch out of a discriminated union by its tag.
 *
 * There is no leniency here on purpose. `contract.ts`'s own docblock states
 * the contract's compatibility policy: new shapes are written *open* —
 * without `additionalProperties: false` — specifically so an additive field
 * from a newer peer is already accepted by a plain `Value.Check`, with no
 * help needed from this module. A schema that *is* closed
 * (`external-agent.*`'s params, results and event payload; `ToolchainSelection`;
 * `runtime.health`'s `externalAgents` subtree; `identityIsolation`) is closed
 * deliberately, as a review boundary — `contract.ts`: "a member nobody
 * declared is a vendor surface nobody reviewed." Relaxing those here would be
 * a second, contradicting interpretation of a schema-first contract, which is
 * exactly what this repo's shared-contract rule forbids: the TypeBox schema
 * in `apps/shared` is the single source of truth. A closed shape that proves
 * too brittle across releases gets opened there, once, with a regenerated
 * catalog — not tolerated a second time at this boundary.
 */

import type { TSchema } from 'typebox';
import Value from 'typebox/value';
import { type ContractViolation, describeContractViolation } from './contract-violation';

export type ContractCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly violation: ContractViolation };

/**
 * `value` against `schema`, exactly as the contract declares it — no
 * tolerance beyond what the schema itself already grants by being open. On
 * failure, the violation names the schema path and TypeBox's own message,
 * never the rejected value.
 *
 * @example
 * checkAgainstContract(Type.Object({ a: Type.String() }), { a: 'x', extra: 1 });
 * // => { ok: true } — the schema has no `additionalProperties: false`
 */
export function checkAgainstContract(schema: TSchema, value: unknown): ContractCheckResult {
  if (Value.Check(schema, value)) return { ok: true };
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
