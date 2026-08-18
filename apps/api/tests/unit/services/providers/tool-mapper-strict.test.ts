import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { TODO_CONTENT_MAX_LENGTH } from '@mangostudio/shared/todos';
import { buildCachedAnthropicRequest } from '../../../../src/services/providers/anthropic/cached-request';
import {
  isStrictCompatible,
  toolDefsToChatCompletions,
  toolDefsToGeminiInteractions,
  toolDefsToResponsesAPI,
  toPlainJsonSchema,
  toStrictSchema,
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
  // tool regresses and another is added. The check runs on the *transformed*
  // schema, so it proves the pipeline, not that each author remembered the
  // dialect.
  for (const name of expectedToolNames()) {
    it(`sends ${name} with strict: true`, () => {
      expect(isStrictCompatible(toStrictSchema(parametersOf(name)))).toBe(true);
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

function asSchema(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not a schema object.`);
  }
  return value as Record<string, unknown>;
}

function schemaProperty(
  schema: Record<string, unknown>,
  ...path: string[]
): Record<string, unknown> {
  let node: unknown = schema;
  for (const key of path) {
    node = asSchema(node, path.join('.'))[key];
  }
  return asSchema(node, path.join('.'));
}

/**
 * Drops `minLength`/`maxLength` from schema nodes, never from a `properties`
 * map's keys: an argument literally named `maxLength` must survive.
 */
function stripLengthBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripLengthBounds);
  if (!node || typeof node !== 'object') return node;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, sub]) => [
          name,
          stripLengthBounds(sub),
        ])
      );
      continue;
    }
    if (key === 'minLength' || key === 'maxLength') continue;
    result[key] = stripLengthBounds(value);
  }
  return result;
}

function plainMappedSchemas(def: ToolDefinition): {
  chat: Record<string, unknown>;
  gemini: Record<string, unknown>;
  anthropic: Record<string, unknown>;
} {
  const chatTool = toolDefsToChatCompletions([def])[0];
  if (chatTool?.type !== 'function') {
    throw new Error(`Chat Completions mapping missing for ${def.name}.`);
  }
  const gemini = toolDefsToGeminiInteractions([def])[0];
  const anthropic = buildCachedAnthropicRequest({
    systemPrompt: 'mapper-test',
    toolDefinitions: [def],
    messages: [{ role: 'user', content: 'hi' }],
  }).tools?.[0];
  return {
    chat: asSchema(chatTool.function.parameters, `${def.name} chat`),
    gemini: asSchema(gemini?.parameters, `${def.name} gemini`),
    anthropic: asSchema(
      anthropic && 'input_schema' in anthropic ? anthropic.input_schema : undefined,
      `${def.name} anthropic`
    ),
  };
}

describe('toStrictSchema', () => {
  it('emits additionalProperties: false and a complete required at every depth', () => {
    const strict = toStrictSchema({
      type: 'object',
      properties: {
        child: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['value'],
        },
      },
      required: [],
      additionalProperties: false,
    });

    expect(strict).toEqual({
      type: 'object',
      properties: {
        child: {
          type: ['object', 'null'],
          properties: {
            value: { type: 'string' },
            note: { type: ['string', 'null'] },
          },
          required: ['value', 'note'],
          additionalProperties: false,
        },
      },
      required: ['child'],
      additionalProperties: false,
    });
  });

  it('still produces a strict schema when an argument is named maxLength or not', () => {
    // Invisible without this test: those keys collide with schema keywords,
    // and treating them as keywords would drop the property or refuse strict.
    const strict = toStrictSchema({
      type: 'object',
      properties: {
        maxLength: { type: 'string' },
        not: { type: 'integer', minimum: 1 },
      },
      required: ['maxLength'],
      additionalProperties: false,
    });

    expect(isStrictCompatible(strict)).toBe(true);
    expect(schemaProperty(strict, 'properties', 'maxLength')).toEqual({ type: 'string' });
    expect(schemaProperty(strict, 'properties', 'not')).toEqual({
      type: ['integer', 'null'],
      minimum: 1,
    });
    expect(strict.required).toEqual(['maxLength', 'not']);
  });

  it('drops length bounds and leaves composition keywords so strict can still be refused', () => {
    const withBounds = toStrictSchema({
      type: 'object',
      properties: { a: { type: 'string', minLength: 1, maxLength: 10 } },
      required: ['a'],
      additionalProperties: false,
    });
    expect(schemaProperty(withBounds, 'properties', 'a')).toEqual({ type: 'string' });
    expect(isStrictCompatible(withBounds)).toBe(true);

    const withOneOf = toStrictSchema({
      type: 'object',
      properties: { a: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
      required: ['a'],
      additionalProperties: false,
    });
    expect(schemaProperty(withOneOf, 'properties', 'a')).toEqual({
      oneOf: [{ type: 'string' }, { type: 'number' }],
    });
    expect(isStrictCompatible(withOneOf)).toBe(false);
  });

  it('leaves free-form object nodes open instead of closing them', () => {
    const strict = toStrictSchema({
      type: 'object',
      properties: {
        metadata: { type: 'object' },
        tags: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['metadata'],
      additionalProperties: false,
    });

    expect(schemaProperty(strict, 'properties', 'metadata')).toEqual({ type: 'object' });
    expect(schemaProperty(strict, 'properties', 'tags')).toEqual({
      type: ['object', 'null'],
      additionalProperties: { type: 'string' },
    });
    expect(isStrictCompatible(strict)).toBe(false);
  });

  it('does not walk const, enum, default, or examples values as subschemas', () => {
    const strict = toStrictSchema({
      type: 'object',
      properties: {
        payload: {
          type: 'string',
          enum: [{ maxLength: 5 }],
          const: { minLength: 1 },
          default: { type: 'object' },
          examples: [{ not: true }],
        },
      },
      required: ['payload'],
      additionalProperties: false,
    });

    expect(schemaProperty(strict, 'properties', 'payload')).toEqual({
      type: 'string',
      enum: [{ maxLength: 5 }],
      const: { minLength: 1 },
      default: { type: 'object' },
      examples: [{ not: true }],
    });
  });
});

describe('toolDefsToResponsesAPI', () => {
  it('sends the source schema when the derived one is not strict-compatible', () => {
    const def: ToolDefinition = {
      name: 'search',
      description: 'search',
      parameters: {
        type: 'object',
        properties: {
          q: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        },
        required: [],
        additionalProperties: false,
      },
    };

    const [mapped] = toolDefsToResponsesAPI([def]);
    expect(mapped?.strict).toBe(false);
    expect(mapped?.parameters).toEqual(def.parameters);
  });

  it('does not mark a free-form object tool as strict', () => {
    const def: ToolDefinition = {
      name: 'annotate',
      description: 'annotate',
      parameters: {
        type: 'object',
        properties: { metadata: { type: 'object' } },
        required: ['metadata'],
      },
    };

    const [mapped] = toolDefsToResponsesAPI([def]);
    expect(mapped?.strict).toBe(false);
    expect(mapped?.parameters).toEqual(def.parameters);
  });
});

describe('toPlainJsonSchema(toStrictSchema(s)) round-trip', () => {
  it('equals every built-in source schema, modulo length bounds the strict subset drops', () => {
    const mismatches: string[] = [];
    for (const tool of getAllTools()) {
      const source = tool.definition.parameters;
      const roundTripped = toPlainJsonSchema(toStrictSchema(source));
      if (JSON.stringify(roundTripped) !== JSON.stringify(stripLengthBounds(source))) {
        mismatches.push(tool.definition.name);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe('non-Responses providers keep genuine optionals and length bounds', () => {
  it('sends glob, grep, shells, generate_image, and todo_write with optionals and bounds', () => {
    const glob = getTool('glob')?.definition;
    const grep = getTool('grep')?.definition;
    const bash = getTool('bash')?.definition;
    const image = getTool('generate_image')?.definition;
    const todo = getTool('todo_write')?.definition;
    if (!glob || !grep || !bash || !image || !todo) {
      throw new Error('Expected bound-bearing tools to be registered.');
    }

    for (const def of [glob, grep, bash, image, todo]) {
      const mapped = plainMappedSchemas(def);
      const plain = toPlainJsonSchema(def.parameters);
      expect(mapped.chat).toEqual(plain);
      expect(mapped.gemini).toEqual(plain);
      expect(mapped.anthropic).toEqual(plain);
    }

    const globPlain = toPlainJsonSchema(glob.parameters);
    expect(globPlain.required).toEqual(['pattern']);
    expect(schemaProperty(globPlain, 'properties', 'pattern').minLength).toBe(1);
    expect(schemaProperty(globPlain, 'properties', 'cwd').type).toBe('string');

    const grepPlain = toPlainJsonSchema(grep.parameters);
    expect(grepPlain.required).toEqual(['pattern']);
    expect(schemaProperty(grepPlain, 'properties', 'pattern').minLength).toBe(1);

    const bashPlain = toPlainJsonSchema(bash.parameters);
    expect(bashPlain.required).toEqual(['command']);
    expect(schemaProperty(bashPlain, 'properties', 'command').minLength).toBe(1);

    const imagePlain = toPlainJsonSchema(image.parameters);
    expect(imagePlain.required).toEqual(['prompt']);
    expect(schemaProperty(imagePlain, 'properties', 'prompt').minLength).toBe(1);
    expect(schemaProperty(imagePlain, 'properties', 'quality').enum).toEqual([
      '512px',
      '1K',
      '2K',
      '4K',
    ]);

    const todoPlain = toPlainJsonSchema(todo.parameters);
    const content = schemaProperty(
      todoPlain,
      'properties',
      'todos',
      'items',
      'properties',
      'content'
    );
    expect(content.minLength).toBe(1);
    expect(content.maxLength).toBe(TODO_CONTENT_MAX_LENGTH);
  });
});
