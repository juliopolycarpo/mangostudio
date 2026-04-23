/**
 * Shared tool definition mapping helpers.
 *
 * Converts the internal ToolDefinition shape to provider-specific tool schemas.
 * Each provider has slightly different wire formats; this module provides
 * the common conversion primitives.
 */

import type { ToolDefinition } from '../types';
import type OpenAI from 'openai';

/**
 * Converts internal ToolDefinitions to OpenAI Chat Completions tool format.
 * Used by openai-compatible endpoints and the legacy Chat Completions path.
 */
export function toolDefsToChatCompletions(defs: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
  return defs.map((def) => ({
    type: 'function' as const,
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    },
  }));
}

/**
 * Returns true when the given JSON Schema satisfies the subset required by
 * OpenAI Responses' strict function tool mode:
 *   - top-level `type: 'object'`
 *   - `additionalProperties: false`
 *   - every property key appears in `required`
 *   - no unsupported keywords (`oneOf`, `anyOf`, `allOf`, `not`, `$ref`)
 *
 * Strict is enabled per-tool; tools whose schemas don't pass are sent with
 * `strict: false` so validation never blocks the call.
 */
export function isStrictCompatible(schema: Record<string, unknown> | undefined | null): boolean {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.type !== 'object') return false;
  if (schema.additionalProperties !== false) return false;

  const properties = schema.properties;
  if (properties !== undefined && (typeof properties !== 'object' || properties === null)) {
    return false;
  }
  const propertyKeys = properties && typeof properties === 'object' ? Object.keys(properties) : [];
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  const requiredSet = new Set(required.filter((k): k is string => typeof k === 'string'));
  for (const key of propertyKeys) {
    if (!requiredSet.has(key)) return false;
  }

  return !hasUnsupportedStrictKeywords(schema);
}

const UNSUPPORTED_STRICT_KEYWORDS = ['oneOf', 'anyOf', 'allOf', 'not', '$ref'] as const;

function hasUnsupportedStrictKeywords(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) {
    return node.some((item) => hasUnsupportedStrictKeywords(item));
  }
  const obj = node as Record<string, unknown>;
  for (const keyword of UNSUPPORTED_STRICT_KEYWORDS) {
    if (keyword in obj) return true;
  }
  for (const value of Object.values(obj)) {
    if (hasUnsupportedStrictKeywords(value)) return true;
  }
  return false;
}

/**
 * Converts internal ToolDefinitions to the OpenAI Responses API tool format.
 *
 * Each tool's `strict` flag is set individually: tools whose schemas satisfy
 * the strict subset get `strict: true` (the model is forced to match the
 * schema exactly); others keep `strict: false` to preserve compatibility.
 */
export function toolDefsToResponsesAPI(defs: ToolDefinition[]): Array<Record<string, unknown>> {
  return defs.map((def) => ({
    type: 'function',
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    strict: isStrictCompatible(def.parameters),
  }));
}

/**
 * Converts internal ToolDefinitions to the Gemini Interactions API tool format.
 */
export function toolDefsToGeminiInteractions(
  defs: ToolDefinition[]
): Array<{ type: 'function'; name: string; description: string; parameters: unknown }> {
  return defs.map((def) => ({
    type: 'function' as const,
    name: def.name,
    description: def.description,
    parameters: def.parameters,
  }));
}
