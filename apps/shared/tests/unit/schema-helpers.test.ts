import { describe, expect, it } from 'bun:test';
import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ReadonlyArraySchema } from '../../src/schema-helpers';

// Compile-time type-equality helper — `bun run check` (tsgo) fails on drift.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<_T extends true>(): void {
  // Compile-time only: the type parameter constraint does the work.
}

const StringListSchema = ReadonlyArraySchema(Type.String());

// The inferred type must stay `ReadonlyArray<T>`, not the mutable `T[]` that
// `Type.Array` would produce.
assertType<Equals<Static<typeof StringListSchema>, ReadonlyArray<string>>>();

describe('ReadonlyArraySchema', () => {
  it('validates a homogeneous array at runtime like a normal array', () => {
    expect(Value.Check(StringListSchema, ['a', 'b'])).toBe(true);
    expect(Value.Check(StringListSchema, [])).toBe(true);
  });

  it('rejects non-arrays and arrays with the wrong element type', () => {
    expect(Value.Check(StringListSchema, 'a')).toBe(false);
    expect(Value.Check(StringListSchema, [1, 2])).toBe(false);
  });

  it('forwards array options such as minItems', () => {
    const NonEmptySchema = ReadonlyArraySchema(Type.String(), { minItems: 1 });
    expect(Value.Check(NonEmptySchema, [])).toBe(false);
    expect(Value.Check(NonEmptySchema, ['only'])).toBe(true);
  });
});
