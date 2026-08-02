/**
 * Flattens an MCP form `requestedSchema` into UI field descriptors. Only the
 * primitive shapes the MCP elicitation spec allows are accepted; anything else
 * is skipped so the card stays renderable.
 */

import type { McpElicitationField, McpElicitationFieldFormat } from '@mangostudio/shared/mcp';

const FIELD_FORMATS = new Set<McpElicitationFieldFormat>(['email', 'uri', 'date', 'date-time']);

/**
 * Converts a form elicitation `requestedSchema` into ordered field descriptors.
 * // Usage: const fields = flattenElicitationSchema(params.requestedSchema)
 */
export function flattenElicitationSchema(schema: unknown): McpElicitationField[] {
  if (!isRecord(schema) || schema.type !== 'object' || !isRecord(schema.properties)) {
    return [];
  }

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : []
  );

  const fields: McpElicitationField[] = [];
  for (const [name, raw] of Object.entries(schema.properties)) {
    const field = flattenProperty(name, raw, required.has(name));
    if (field) fields.push(field);
  }
  return fields;
}

function flattenProperty(
  name: string,
  raw: unknown,
  required: boolean
): McpElicitationField | undefined {
  if (!isRecord(raw) || typeof raw.type !== 'string') return undefined;

  const title = typeof raw.title === 'string' ? raw.title : undefined;
  const description = typeof raw.description === 'string' ? raw.description : undefined;
  const base = {
    name,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    required,
  };

  if (raw.type === 'boolean') {
    return {
      ...base,
      kind: 'boolean',
      ...(typeof raw.default === 'boolean' ? { default: raw.default } : {}),
    };
  }

  if (raw.type === 'number' || raw.type === 'integer') {
    return {
      ...base,
      kind: raw.type,
      ...(typeof raw.minimum === 'number' ? { minimum: raw.minimum } : {}),
      ...(typeof raw.maximum === 'number' ? { maximum: raw.maximum } : {}),
      ...(typeof raw.default === 'number' ? { default: raw.default } : {}),
    };
  }

  if (raw.type === 'array') {
    return flattenMultiEnum(base, raw);
  }

  if (raw.type === 'string') {
    return flattenStringField(base, raw);
  }

  return undefined;
}

function flattenStringField(
  base: Pick<McpElicitationField, 'name' | 'title' | 'description' | 'required'>,
  raw: Record<string, unknown>
): McpElicitationField | undefined {
  const enumOptions = readEnumOptions(raw);
  if (enumOptions) {
    return {
      ...base,
      kind: 'enum',
      options: enumOptions,
      ...(typeof raw.default === 'string' ? { default: raw.default } : {}),
    };
  }

  const format =
    typeof raw.format === 'string' && FIELD_FORMATS.has(raw.format as McpElicitationFieldFormat)
      ? (raw.format as McpElicitationFieldFormat)
      : undefined;

  return {
    ...base,
    kind: 'string',
    ...(format ? { format } : {}),
    ...(typeof raw.minLength === 'number' ? { minLength: raw.minLength } : {}),
    ...(typeof raw.maxLength === 'number' ? { maxLength: raw.maxLength } : {}),
    ...(typeof raw.default === 'string' ? { default: raw.default } : {}),
  };
}

function flattenMultiEnum(
  base: Pick<McpElicitationField, 'name' | 'title' | 'description' | 'required'>,
  raw: Record<string, unknown>
): McpElicitationField | undefined {
  if (!isRecord(raw.items)) return undefined;
  const options = readEnumOptions(raw.items) ?? readAnyOfOptions(raw.items);
  if (!options) return undefined;

  const defaultValue = Array.isArray(raw.default)
    ? raw.default.filter((value): value is string => typeof value === 'string')
    : undefined;

  return {
    ...base,
    kind: 'multi_enum',
    options,
    ...(typeof raw.minItems === 'number' ? { minItems: raw.minItems } : {}),
    ...(typeof raw.maxItems === 'number' ? { maxItems: raw.maxItems } : {}),
    ...(defaultValue ? { default: defaultValue } : {}),
  };
}

function readEnumOptions(
  raw: Record<string, unknown>
): Array<{ value: string; label: string }> | undefined {
  if (!Array.isArray(raw.enum) || raw.enum.length === 0) return undefined;
  const values = raw.enum.filter((value): value is string => typeof value === 'string');
  if (values.length === 0) return undefined;

  const names = Array.isArray(raw.enumNames)
    ? raw.enumNames.filter((value): value is string => typeof value === 'string')
    : undefined;

  return values.map((value, index) => ({
    value,
    label: names?.[index] ?? value,
  }));
}

function readAnyOfOptions(
  raw: Record<string, unknown>
): Array<{ value: string; label: string }> | undefined {
  if (!Array.isArray(raw.anyOf) || raw.anyOf.length === 0) return undefined;
  const options: Array<{ value: string; label: string }> = [];
  for (const entry of raw.anyOf) {
    if (!isRecord(entry) || typeof entry.const !== 'string') continue;
    options.push({
      value: entry.const,
      label: typeof entry.title === 'string' ? entry.title : entry.const,
    });
  }
  return options.length > 0 ? options : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
