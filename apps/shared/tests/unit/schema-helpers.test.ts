import { describe, expect, it } from 'bun:test';
import Type, { type Static } from 'typebox';
import Value from 'typebox/value';
import { ReadonlyArraySchema } from '../../src/schema-helpers';
import { assertType, type Equals } from '../../src/test-utils/type-assert';

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
