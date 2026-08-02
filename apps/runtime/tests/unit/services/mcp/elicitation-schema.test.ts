import { describe, expect, it } from 'bun:test';
import { flattenElicitationSchema } from '../../../../src/services/mcp/elicitation-schema';

describe('flattenElicitationSchema', () => {
  it('flattens string, enum, multi-enum, number, and boolean fields', () => {
    const fields = flattenElicitationSchema({
      type: 'object',
      required: ['name', 'tier'],
      properties: {
        name: { type: 'string', title: 'Name', minLength: 1 },
        tier: {
          type: 'string',
          enum: ['free', 'pro'],
          enumNames: ['Free', 'Pro'],
          default: 'free',
        },
        tags: {
          type: 'array',
          items: { type: 'string', enum: ['a', 'b'] },
        },
        age: { type: 'integer', minimum: 0, maximum: 120 },
        notify: { type: 'boolean', default: true },
      },
    });

    expect(fields).toEqual([
      {
        name: 'name',
        title: 'Name',
        required: true,
        kind: 'string',
        minLength: 1,
      },
      {
        name: 'tier',
        required: true,
        kind: 'enum',
        options: [
          { value: 'free', label: 'Free' },
          { value: 'pro', label: 'Pro' },
        ],
        default: 'free',
      },
      {
        name: 'tags',
        required: false,
        kind: 'multi_enum',
        options: [
          { value: 'a', label: 'a' },
          { value: 'b', label: 'b' },
        ],
      },
      {
        name: 'age',
        required: false,
        kind: 'integer',
        minimum: 0,
        maximum: 120,
      },
      {
        name: 'notify',
        required: false,
        kind: 'boolean',
        default: true,
      },
    ]);
  });

  it('returns an empty list for non-object schemas', () => {
    expect(flattenElicitationSchema({ type: 'string' })).toEqual([]);
    expect(flattenElicitationSchema(null)).toEqual([]);
  });
});
