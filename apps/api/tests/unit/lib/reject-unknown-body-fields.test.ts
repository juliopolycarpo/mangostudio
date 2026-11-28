/**
 * `rejectUnknownBodyFields` swaps `additionalProperties: false` for
 * `additionalProperties: Type.Never()` on a copy, so Elysia rc.5 rejects an
 * unknown field instead of stripping it. These cases pin where it reaches, what
 * it leaves alone, and that the shared schema it is given is never touched.
 */

import { describe, expect, it } from 'bun:test';

import { type TSchema, Type } from 'typebox';
import Value from 'typebox/value';

import {
  declaresClosedObject,
  rejectUnknownBodyFields,
} from '../../../src/lib/reject-unknown-body-fields';

const CLOSED = { additionalProperties: false } as const;
const UNKNOWN = 'unknownFieldFromUnitTest';

/** Freezes every plain object and array under `value`, so a write to the input throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Whether `schema` accepts `value`, reported with the schema on a failed expectation. */
function accepts(schema: TSchema, value: unknown): boolean {
  return Value.Check(schema, value);
}

function expectRejectsUnknownAt(schema: TSchema, valid: unknown, withUnknown: unknown): void {
  expect(accepts(schema, valid), `expected the valid body ${JSON.stringify(valid)} to pass`).toBe(
    true
  );
  expect(
    accepts(schema, withUnknown),
    `expected ${JSON.stringify(withUnknown)} to be rejected for its unknown field`
  ).toBe(false);
}

describe('rejectUnknownBodyFields', () => {
  it('closes a root object so an unknown field fails the check', () => {
    const original = Type.Object({ name: Type.String() }, CLOSED);
    const copy = rejectUnknownBodyFields(original);

    expect(declaresClosedObject(copy)).toBe(false);
    expectRejectsUnknownAt(copy, { name: 'a' }, { name: 'a', [UNKNOWN]: 1 });
  });

  it('writes the Never spelling Elysia does not strip, which serializes as not: {}', () => {
    const copy = rejectUnknownBodyFields(Type.Object({ name: Type.String() }, CLOSED));

    expect(JSON.parse(JSON.stringify(copy)).additionalProperties).toEqual({ not: {} });
  });

  it('reaches an object nested in properties', () => {
    const copy = rejectUnknownBodyFields(
      Type.Object({ inner: Type.Object({ name: Type.String() }, CLOSED) }, CLOSED)
    );

    expectRejectsUnknownAt(copy, { inner: { name: 'a' } }, { inner: { name: 'a', [UNKNOWN]: 1 } });
  });

  it('reaches a closed object under an open root', () => {
    const copy = rejectUnknownBodyFields(
      Type.Object({ inner: Type.Object({ name: Type.String() }, CLOSED) })
    );

    expectRejectsUnknownAt(copy, { inner: { name: 'a' } }, { inner: { name: 'a', [UNKNOWN]: 1 } });
    expect(accepts(copy, { inner: { name: 'a' }, [UNKNOWN]: 1 }), 'the open root stays open').toBe(
      true
    );
  });

  it('reaches array items', () => {
    const copy = rejectUnknownBodyFields(
      Type.Object({ rows: Type.Array(Type.Object({ id: Type.String() }, CLOSED)) }, CLOSED)
    );

    expectRejectsUnknownAt(
      copy,
      { rows: [{ id: 'a' }] },
      { rows: [{ id: 'a' }, { id: 'b', [UNKNOWN]: 1 }] }
    );
  });

  it('reaches every member of a union', () => {
    const copy = rejectUnknownBodyFields(
      Type.Union([
        Type.Object({ kind: Type.Literal('a'), a: Type.String() }, CLOSED),
        Type.Object({ kind: Type.Literal('b'), b: Type.String() }, CLOSED),
      ])
    );

    expectRejectsUnknownAt(copy, { kind: 'b', b: 'x' }, { kind: 'b', b: 'x', [UNKNOWN]: 1 });
    expect(accepts(copy, { kind: 'a', a: 'x', [UNKNOWN]: 1 })).toBe(false);
  });

  it('reaches an optional union of a closed object and null', () => {
    // The shape of the tool-identity image update.
    const copy = rejectUnknownBodyFields(
      Type.Object(
        {
          image: Type.Optional(
            Type.Union([
              Type.Object({ url: Type.String(), cache: Type.Boolean() }, CLOSED),
              Type.Null(),
            ])
          ),
        },
        CLOSED
      )
    );

    expect(accepts(copy, {}), 'the optional member stays optional').toBe(true);
    expect(accepts(copy, { image: null }), 'the null arm stays valid').toBe(true);
    expectRejectsUnknownAt(
      copy,
      { image: { url: 'https://example.test/i.png', cache: true } },
      { image: { url: 'https://example.test/i.png', cache: true, [UNKNOWN]: 1 } }
    );
  });

  it('reaches both sides of an intersection', () => {
    const copy = rejectUnknownBodyFields(
      Type.Intersect([
        Type.Object({ a: Type.String() }, CLOSED),
        Type.Object({ b: Type.String() }, CLOSED),
      ])
    );

    // Closed members each reject the other's key, so a body that satisfies both
    // arms of the original cannot exist; what matters is that the unknown field
    // is rejected rather than that this particular intersection is satisfiable.
    expect(declaresClosedObject(copy)).toBe(false);
    expect(accepts(copy, { a: 'x', b: 'y', [UNKNOWN]: 1 })).toBe(false);
  });

  it('reaches the value schema of a record (patternProperties)', () => {
    const copy = rejectUnknownBodyFields(
      Type.Record(Type.String(), Type.Object({ id: Type.String() }, CLOSED))
    );

    expectRejectsUnknownAt(copy, { first: { id: 'a' } }, { first: { id: 'a', [UNKNOWN]: 1 } });
  });

  it('reaches definitions a $ref points at', () => {
    const original = {
      type: 'object',
      properties: { item: { $ref: '#/$defs/Item' } },
      required: ['item'],
      $defs: {
        Item: { type: 'object', properties: { id: { type: 'string' } }, ...CLOSED },
      },
    } as unknown as TSchema;
    const copy = rejectUnknownBodyFields(original);

    expect(declaresClosedObject(copy)).toBe(false);
    expect(declaresClosedObject(original), 'the input keeps its closed definition').toBe(true);
  });

  it('leaves an open object open', () => {
    const copy = rejectUnknownBodyFields(Type.Object({ name: Type.String() }));

    expect(accepts(copy, { name: 'a', [UNKNOWN]: 1 })).toBe(true);
  });

  it('leaves an explicit additionalProperties: true, and a typed one, as written', () => {
    const permissive = rejectUnknownBodyFields(
      Type.Object({ name: Type.String() }, { additionalProperties: true })
    );
    const typed = rejectUnknownBodyFields(
      Type.Object({ name: Type.String() }, { additionalProperties: Type.Number() })
    );

    expect(accepts(permissive, { name: 'a', [UNKNOWN]: 'text' })).toBe(true);
    expect(accepts(typed, { name: 'a', extra: 1 })).toBe(true);
    expect(accepts(typed, { name: 'a', extra: 'text' })).toBe(false);
  });

  it('keeps optional properties and their requiredness', () => {
    const copy = rejectUnknownBodyFields(
      Type.Object({ name: Type.String(), note: Type.Optional(Type.String()) }, CLOSED)
    );

    expect(accepts(copy, { name: 'a' })).toBe(true);
    expect(accepts(copy, { note: 'x' }), 'a missing required field still fails').toBe(false);
  });

  it('keeps validation keywords and defaults on the copied nodes', () => {
    const copy = rejectUnknownBodyFields(
      Type.Object(
        { name: Type.String({ minLength: 3 }), mode: Type.String({ default: 'fast' }) },
        CLOSED
      )
    );

    expect(accepts(copy, { name: 'ab', mode: 'x' }), 'minLength survives the copy').toBe(false);
    expect(Value.Create(copy)).toMatchObject({ mode: 'fast' });
  });

  it('does not rewrite a default or const that merely looks like a schema', () => {
    const original = Type.Object(
      {
        shape: Type.Unknown({ default: { additionalProperties: false } }),
        tag: Type.Literal('x'),
      },
      CLOSED
    );
    const copy = rejectUnknownBodyFields(original);

    expect(Value.Create(copy)).toMatchObject({ shape: { additionalProperties: false } });
  });

  it('does not mutate the schema it is given, even a deeply frozen one', () => {
    const original = deepFreeze(
      Type.Object({ inner: Type.Object({ name: Type.String() }, CLOSED) }, CLOSED)
    );
    const before = JSON.stringify(original);

    const copy = rejectUnknownBodyFields(original);

    expect(copy).not.toBe(original);
    expect(JSON.stringify(original)).toBe(before);
    expect(declaresClosedObject(original), 'the shared schema stays closed for responses').toBe(
      true
    );
  });

  it('returns the same copy for the same schema, so a validator cache sees one object', () => {
    const original = Type.Object({ name: Type.String() }, CLOSED);

    expect(rejectUnknownBodyFields(original)).toBe(rejectUnknownBodyFields(original));
  });

  it('copies a sub-schema reused in several places once, and survives a self-reference', () => {
    const shared = Type.Object({ id: Type.String() }, CLOSED);
    const copy = rejectUnknownBodyFields(Type.Object({ left: shared, right: shared }, CLOSED));
    expect(copy.properties.left).toBe(copy.properties.right);

    const cyclic: Record<string, unknown> = { type: 'object', ...CLOSED, properties: {} };
    (cyclic.properties as Record<string, unknown>).self = cyclic;
    const cyclicCopy = rejectUnknownBodyFields(cyclic as unknown as TSchema) as unknown as {
      properties: { self: unknown };
    };
    expect(cyclicCopy.properties.self).toBe(cyclicCopy);
  });
});

describe('declaresClosedObject', () => {
  it('finds a closure at the root and at depth', () => {
    expect(declaresClosedObject(Type.Object({ a: Type.String() }, CLOSED))).toBe(true);
    expect(
      declaresClosedObject(
        Type.Object({ rows: Type.Array(Type.Union([Type.Object({ a: Type.String() }, CLOSED)])) })
      )
    ).toBe(true);
  });

  it('is false for an open schema and for the Never spelling', () => {
    expect(declaresClosedObject(Type.Object({ a: Type.String() }))).toBe(false);
    expect(
      declaresClosedObject(
        Type.Object({ a: Type.String() }, { additionalProperties: Type.Never() })
      )
    ).toBe(false);
  });

  it('ignores a default that holds the keyword as data', () => {
    expect(declaresClosedObject(Type.Unknown({ default: { additionalProperties: false } }))).toBe(
      false
    );
  });
});
