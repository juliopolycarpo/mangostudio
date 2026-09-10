import Type, { type Static, type TSchema } from 'typebox';

/**
 * Array schema whose inferred type is `ReadonlyArray<T>` while validating like a
 * normal array at runtime.
 *
 * TypeBox's `Type.Array` always infers a mutable `T[]`. Some shared contracts
 * intentionally expose immutable arrays (e.g. agent tool lists, reasoning effort
 * policies); deriving those types from a plain array schema would widen them to
 * mutable and break call sites that pass `ReadonlyArray` values in. This helper
 * keeps the schema canonical (one source of truth) without losing the readonly
 * guarantee in the derived type.
 *
 * Usage:
 *   const ToolNamesSchema = ReadonlyArraySchema(Type.String());
 *   type ToolNames = Static<typeof ToolNamesSchema>; // ReadonlyArray<string>
 */
export function ReadonlyArraySchema<T extends TSchema>(
  item: T,
  options?: Parameters<typeof Type.Array>[1]
) {
  return Type.Unsafe<ReadonlyArray<Static<T>>>(Type.Array(item, options));
}

/**
 * Object schema that validates "is a JSON object" while inferring `T`.
 *
 * A contract method whose parameters have no TypeBox schema yet still needs a
 * schema entry, and the honest one is the check the dispatcher used to run by
 * hand: an object, nothing more. Wrapping the declared TypeScript shape keeps
 * the typed client and handler map exact without claiming a validation the
 * schema does not perform — replace one with a real schema and nothing else
 * has to move.
 *
 * Usage:
 *   const ParamsSchema = UnsafeObjectSchema<RuntimeReadFileParams>();
 *   type Params = Static<typeof ParamsSchema>; // RuntimeReadFileParams
 */
export function UnsafeObjectSchema<T>() {
  return Type.Unsafe<T>({ type: 'object' });
}
