import { describe, expect, it } from 'bun:test';
import {
  compareDefinitions,
  crossFileDefinitions,
  type Definitions,
  isConstTaggedUnion,
  normalizeSchema,
  schemaDifferences,
  stripNullAlternative,
} from './schema-equality';

const ping = { type: 'object', properties: { type: { type: 'string', const: 'ping' } } };
const pong = { type: 'object', properties: { type: { type: 'string', const: 'pong' } } };

describe('isConstTaggedUnion', () => {
  it('accepts branches with distinct type consts', () => {
    expect(isConstTaggedUnion([ping, pong])).toBe(true);
  });

  it('refuses a repeated tag, an untagged branch and an empty list', () => {
    expect(isConstTaggedUnion([ping, ping])).toBe(false);
    expect(isConstTaggedUnion([ping, { type: 'string' }])).toBe(false);
    expect(isConstTaggedUnion([])).toBe(false);
  });
});

describe('stripNullAlternative', () => {
  it('drops null from a type list', () => {
    expect(stripNullAlternative({ type: ['string', 'null'], maxLength: 3 })).toEqual({
      type: 'string',
      maxLength: 3,
    });
  });

  it('merges the non-null branch of a two-way anyOf', () => {
    expect(
      stripNullAlternative({
        anyOf: [{ $ref: '#/$defs/limits' }, { type: 'null' }],
        description: 'x',
      })
    ).toEqual({ $ref: '#/$defs/limits', description: 'x' });
  });

  it('leaves a genuine union alone', () => {
    const union = { anyOf: [ping, pong] };
    expect(stripNullAlternative(union)).toBe(union);
  });
});

describe('normalizeSchema', () => {
  const definitions: Definitions = { id: { type: 'string', minLength: 1, description: 'id' } };

  it('inlines $ref, drops annotations and format, and sorts keys', () => {
    expect(
      normalizeSchema(
        { $ref: '#/$defs/id', description: 'req id', format: 'uuid', title: 'x' },
        definitions
      )
    ).toEqual({ minLength: 1, type: 'string' });
  });

  it('inlines a $ref hidden behind a schemars null alternative', () => {
    const schema = { anyOf: [{ $ref: '#/$defs/id' }, { type: 'null' }] };
    expect(normalizeSchema(schema, definitions)).toEqual({ minLength: 1, type: 'string' });
  });

  it('turns a const-tagged anyOf into oneOf and drops additionalProperties: true', () => {
    const schema = { anyOf: [{ ...ping, additionalProperties: true }, pong] };
    expect(normalizeSchema(schema, {})).toEqual({
      oneOf: [
        { properties: { type: { const: 'ping', type: 'string' } }, type: 'object' },
        { properties: { type: { const: 'pong', type: 'string' } }, type: 'object' },
      ],
    });
  });

  it('keeps additionalProperties: false, which changes meaning', () => {
    expect(normalizeSchema({ type: 'object', additionalProperties: false }, {})).toEqual({
      additionalProperties: false,
      type: 'object',
    });
  });

  it('keeps a member whose name collides with a dropped keyword', () => {
    // catalog.json declares a member literally called `description`. Dropping
    // annotation keywords inside `properties` erased it from both sides, so
    // two emitters that disagreed about it compared equal.
    const schema = {
      type: 'object',
      properties: {
        description: { type: 'string' },
        format: { type: 'string' },
        name: { type: 'string', description: 'dropped: this one is an annotation' },
      },
    };

    expect(normalizeSchema(schema, {})).toEqual({
      properties: {
        description: { type: 'string' },
        format: { type: 'string' },
        name: { type: 'string' },
      },
      type: 'object',
    });
  });

  it('reports a divergence in a member called description', () => {
    const mine = { type: 'object', properties: { description: { type: 'string' } } };
    const theirs = { type: 'object', properties: { description: { type: 'number' } } };

    expect(schemaDifferences(normalizeSchema(mine, {}), normalizeSchema(theirs, {}))).toEqual([
      '/properties/description/type: expected "string", got "number"',
    ]);
  });

  it('resolves a $ref inside a member whose name is a dropped keyword', () => {
    const schema = { type: 'object', properties: { description: { $ref: '#/$defs/id' } } };

    expect(normalizeSchema(schema, definitions)).toEqual({
      properties: { description: { minLength: 1, type: 'string' } },
      type: 'object',
    });
  });

  it('inlines a cross-file $ref through merged definitions', () => {
    const merged = {
      ...crossFileDefinitions('protocol.json', definitions),
      local: { type: 'number' },
    };
    expect(normalizeSchema({ $ref: 'protocol.json#/$defs/id' }, merged)).toEqual({
      minLength: 1,
      type: 'string',
    });
    expect(normalizeSchema({ $ref: '#/$defs/local' }, merged)).toEqual({ type: 'number' });
  });

  it('names an unresolvable $ref', () => {
    expect(() => normalizeSchema({ $ref: '#/$defs/nope' }, definitions)).toThrow(
      'unresolvable $ref #/$defs/nope; expected a #/$defs entry or a merged cross-file key'
    );
  });
});

describe('schemaDifferences', () => {
  it('is empty for equal schemas regardless of key order', () => {
    expect(schemaDifferences({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toEqual([]);
  });

  it('reports changed, missing and unexpected members as JSON pointers', () => {
    expect(
      schemaDifferences(
        { a: { minimum: 1 }, b: 2, list: [1, 2] },
        { a: { minimum: 0, maximum: 9 }, list: [1] }
      )
    ).toEqual([
      '/a/maximum: unexpected 9',
      '/a/minimum: expected 1, got 0',
      '/b: missing, expected 2',
      '/list: expected [1,2], got [1]',
    ]);
  });

  it('reports a root-level scalar difference at /', () => {
    expect(schemaDifferences('a', 'b')).toEqual(['/: expected "a", got "b"']);
  });
});

describe('compareDefinitions', () => {
  const spec: Definitions = {
    id: { type: 'string', minLength: 1 },
    cancel: { type: 'object', properties: { id: { $ref: '#/$defs/id' } } },
  };

  it('passes an emission equal to the spec after normalisation', () => {
    const emitted: Definitions = {
      cancel: {
        type: 'object',
        description: 'stop',
        properties: { id: { type: 'string', minLength: 1, format: 'id' } },
      },
    };
    expect(compareDefinitions('rust', emitted, ['cancel'], spec)).toEqual([]);
  });

  it('fails on a missing required key, an unknown key and a value difference', () => {
    const emitted: Definitions = {
      extra: {},
      cancel: { type: 'object', properties: { id: { type: 'string', minLength: 2 } } },
    };
    expect(compareDefinitions('rust', emitted, ['cancel', 'id'], spec)).toEqual([
      'rust: $defs/id is missing',
      'rust: $defs/extra is not in the spec',
      'rust: $defs/cancel/properties/id/minLength: expected 1, got 2',
    ]);
  });
});
