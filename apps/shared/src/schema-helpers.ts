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
