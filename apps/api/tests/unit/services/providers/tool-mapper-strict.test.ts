import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  isStrictCompatible,
  toolDefsToGeminiInteractions,
  toolDefsToResponsesAPI,
  toPlainJsonSchema,
} from '../../../../src/services/providers/core/tool-mapper';
import type { ToolDefinition } from '../../../../src/services/providers/types';
import { registerTools } from '../../../../src/services/tools/register-tools';
import {
  clearRegistry,
  getAllTools,
  getTool,
  registerTool,
} from '../../../../src/services/tools/registry';
import type { RegisteredTool } from '../../../../src/services/tools/types';
import { expectedToolNames } from '../../../support/registration-expectations';

function parametersOf(name: string): Record<string, unknown> {
  const tool = getTool(name);
  if (!tool) throw new Error(`Tool "${name}" is not registered.`);
  return tool.definition.parameters as Record<string, unknown>;
}

function snapshotRegistry(): RegisteredTool[] {
  return getAllTools().map((tool) => ({
    definition: { ...tool.definition },
    settings: { ...tool.settings, parameterDescriptors: [...tool.settings.parameterDescriptors] },
    execute: tool.execute,
    buildDefinition: tool.buildDefinition,
  }));
}

function restoreRegistry(snapshot: RegisteredTool[]): void {
  clearRegistry();
  for (const tool of snapshot) {
    registerTool(tool);
  }
}

let snapshot: RegisteredTool[];

beforeEach(() => {
  snapshot = snapshotRegistry();
  clearRegistry();
  registerTools();
});

afterEach(() => {
  restoreRegistry(snapshot);
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

  it('rejects a nested nullable object that allows additional properties', () => {
    expect(
      isStrictCompatible({
        type: 'object',
        properties: {
          child: {
            type: ['object', 'null'],
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: true,
          },
        },
        required: ['child'],
        additionalProperties: false,
      })
    ).toBe(false);
  });

  it('rejects a nested nullable object with a property left out of required', () => {
    expect(
      isStrictCompatible({
        type: 'object',
        properties: {
          child: {
            type: ['object', 'null'],
            properties: { value: { type: 'string' } },
            required: [],
            additionalProperties: false,
          },
        },
        required: ['child'],
        additionalProperties: false,
      })
    ).toBe(false);
  });

  it('accepts a nested nullable object that is itself strict', () => {
    expect(
      isStrictCompatible({
        type: 'object',
        properties: {
          child: {
            type: ['object', 'null'],
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
        required: ['child'],
        additionalProperties: false,
      })
    ).toBe(true);
  });

  it('rejects an array used as a properties map', () => {
    expect(
      isStrictCompatible({
        type: 'object',
        properties: {
          child: {
            type: 'object',
            properties: [],
            required: [],
            additionalProperties: false,
          },
        },
        required: ['child'],
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

  it('reads a properties map as argument names, not as keywords', () => {
    // An MCP tool may declare an argument literally called `maxLength` or
    // `not`; treating the key as a keyword would drop strict mode from a
    // schema the provider accepts.
    for (const name of ['maxLength', 'minLength', 'not', '$ref', 'anyOf']) {
      expect(
        isStrictCompatible({
          ...base,
          properties: { a: { type: 'string' }, [name]: { type: 'string' } },
          required: ['a', name],
        })
      ).toBe(true);
    }
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

describe('toPlainJsonSchema', () => {
  it('collapses a nullable union and drops the key from required', () => {
    expect(
      toPlainJsonSchema({
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: ['string', 'null'] } },
        required: ['a', 'b'],
        additionalProperties: false,
      })
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    });
  });

  it('drops null from an enum without emptying it', () => {
    expect(
      toPlainJsonSchema({
        type: 'object',
        properties: { mode: { type: ['string', 'null'], enum: ['fast', 'slow', null] } },
        required: ['mode'],
        additionalProperties: false,
      })
    ).toMatchObject({
      properties: { mode: { type: 'string', enum: ['fast', 'slow'] } },
      required: [],
    });
  });

  it('converts nested objects and array items', () => {
    expect(
      toPlainJsonSchema({
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, note: { type: ['string', 'null'] } },
              required: ['label', 'note'],
              additionalProperties: false,
            },
          },
          child: {
            type: ['object', 'null'],
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
        required: ['items', 'child'],
        additionalProperties: false,
      })
    ).toMatchObject({
      properties: {
        items: { items: { properties: { note: { type: 'string' } }, required: ['label'] } },
        child: { type: 'object' },
      },
      required: ['items'],
    });
  });

  it('leaves a schema without nullable keys unchanged', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string', enum: ['x'] } },
      required: ['a'],
      additionalProperties: false,
    };

    expect(toPlainJsonSchema(schema)).toEqual(schema);
  });

  it('does not read a properties map key as a schema keyword', () => {
    expect(
      toPlainJsonSchema({
        type: 'object',
        properties: { type: { type: ['string', 'null'] }, enum: { type: 'string' } },
        required: ['type', 'enum'],
        additionalProperties: false,
      })
    ).toMatchObject({
      properties: { type: { type: 'string' }, enum: { type: 'string' } },
      required: ['enum'],
    });
  });

  it('sends every registered tool to Gemini free of union types and null enums', () => {
    // Gemini takes a subset of OpenAPI, where `type` is one value.
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        for (const [index, item] of node.entries()) walk(item, `${path}[${index}]`);
        return;
      }
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'type' && Array.isArray(value)) offenders.push(`${path}.type`);
        if (key === 'enum' && Array.isArray(value) && value.includes(null)) {
          offenders.push(`${path}.enum`);
        }
        if (key !== 'description') walk(value, `${path}.${key}`);
      }
    };

    for (const tool of toolDefsToGeminiInteractions(getAllTools().map((t) => t.definition))) {
      walk(tool.parameters, tool.name);
    }

    expect(offenders).toEqual([]);
  });
});
