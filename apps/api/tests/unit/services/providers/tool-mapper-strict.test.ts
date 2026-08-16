import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  isStrictCompatible,
  toolDefsToResponsesAPI,
} from '../../../../src/services/providers/core/tool-mapper';
import type { ToolDefinition } from '../../../../src/services/providers/types';
import { registerTools } from '../../../../src/services/tools/register-tools';
import { clearRegistry, getAllTools, getTool } from '../../../../src/services/tools/registry';
import { expectedToolNames } from '../../../support/registration-expectations';

function parametersOf(name: string): Record<string, unknown> {
  const tool = getTool(name);
  if (!tool) throw new Error(`Tool "${name}" is not registered.`);
  return tool.definition.parameters as Record<string, unknown>;
}

beforeAll(() => {
  clearRegistry();
  registerTools();
});

afterAll(() => {
  clearRegistry();
  registerTools();
});

describe('built-in tools enter OpenAI strict function-tool mode', () => {
  // Asserted per tool id rather than as a count: a count stays green when one
  // tool regresses and another is added.
  for (const name of expectedToolNames()) {
    it(`sends ${name} with strict: true`, () => {
      expect(isStrictCompatible(parametersOf(name))).toBe(true);
    });
  }

  it('marks every registered definition strict on the Responses wire', () => {
    const mapped = toolDefsToResponsesAPI(getAllTools().map((tool) => tool.definition));
    const nonStrict = mapped.filter((tool) => tool.strict !== true).map((tool) => tool.name);

    expect(nonStrict).toEqual([]);
  });
});

describe('isStrictCompatible', () => {
  const base = {
    type: 'object',
    properties: { a: { type: 'string' } },
    required: ['a'],
    additionalProperties: false,
  };

  it('accepts a schema whose optional key is nullable and still required', () => {
    expect(
      isStrictCompatible({
        ...base,
        properties: { a: { type: 'string' }, b: { type: ['string', 'null'] } },
        required: ['a', 'b'],
      })
    ).toBe(true);
  });

  it('rejects a property left out of required', () => {
    expect(
      isStrictCompatible({ ...base, properties: { a: { type: 'string' }, b: { type: 'string' } } })
    ).toBe(false);
  });

  it('rejects an optional key nested inside an array item', () => {
    // The provider validates nested objects too, so checking only the top
    // level would wave through a schema the API rejects.
    expect(
      isStrictCompatible({
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, note: { type: 'string' } },
              required: ['label'],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      })
    ).toBe(false);
  });

  it('rejects a nested object that allows additional properties', () => {
    expect(
      isStrictCompatible({
        type: 'object',
        properties: {
          nested: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        },
        required: ['nested'],
        additionalProperties: false,
      })
    ).toBe(false);
  });

  it('rejects string length bounds, which the strict subset does not support', () => {
    for (const keyword of ['minLength', 'maxLength']) {
      expect(
        isStrictCompatible({ ...base, properties: { a: { type: 'string', [keyword]: 1 } } })
      ).toBe(false);
    }
  });

  it('keeps the numeric, enum and array bounds the strict subset does support', () => {
    expect(
      isStrictCompatible({
        ...base,
        properties: {
          a: { type: 'string', enum: ['x', 'y'], pattern: '^[xy]$' },
          b: { type: ['integer', 'null'], minimum: 1, maximum: 10 },
          c: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } },
        },
        required: ['a', 'b', 'c'],
      })
    ).toBe(true);
  });

  it('rejects composition keywords at any depth', () => {
    for (const keyword of ['oneOf', 'anyOf', 'allOf', 'not', '$ref']) {
      expect(
        isStrictCompatible({ ...base, properties: { a: { [keyword]: [{ type: 'string' }] } } })
      ).toBe(false);
    }
  });

  it('rejects a schema that is absent or not an object', () => {
    expect(isStrictCompatible(undefined)).toBe(false);
    expect(isStrictCompatible(null)).toBe(false);
    expect(isStrictCompatible({ type: 'string' } as unknown as ToolDefinition['parameters'])).toBe(
      false
    );
  });
});
