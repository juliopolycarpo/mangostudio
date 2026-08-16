/**
 * Shared tool definition mapping helpers.
 *
 * Converts the internal ToolDefinition shape to provider-specific tool schemas.
 * Each provider has slightly different wire formats; this module provides
 * the common conversion primitives.
 */

import type OpenAI from 'openai';
import type { ToolDefinition } from '../types';

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
 *   - every property key appears in `required`, at every nesting depth
 *   - no unsupported keywords (see `UNSUPPORTED_STRICT_KEYWORDS`)
 *
 * An argument that is genuinely optional is expressed as a nullable type
 * (`type: ['string', 'null']`) with the key still listed in `required`; the
 * parsing helpers in `services/tools/arg-parsing` read `null` as absent.
 *
 * Strict is enabled per-tool; tools whose schemas don't pass are sent with
 * `strict: false` so validation never blocks the call. Every built-in tool is
 * expected to pass — a tool that fails should be fixed rather than exempted.
 */
export function isStrictCompatible(schema: Record<string, unknown> | undefined | null): boolean {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.type !== 'object') return false;
  return isStrictNode(schema);
}

/**
 * Applies every strict rule to each schema node reachable from `node`, in one
 * traversal.
 *
 * A nested object with an optional key — or an unsupported keyword buried in
 * one — is rejected by the provider just as a top-level one is, so
 * `ask_user_question`-shaped schemas cannot be validated by inspecting the top
 * level alone.
 */
function isStrictNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return true;
  if (Array.isArray(node)) return node.every(isStrictNode);

  const obj = node as Record<string, unknown>;
  if (UNSUPPORTED_STRICT_KEYWORDS.some((keyword) => keyword in obj)) return false;

  if (obj.type === 'object') {
    if (obj.additionalProperties !== false) return false;
    const properties = obj.properties;
    if (properties !== undefined) {
      if (typeof properties !== 'object' || properties === null) return false;
      const required = new Set(Array.isArray(obj.required) ? obj.required : []);
      if (!Object.keys(properties).every((key) => required.has(key))) return false;
    }
  }

  return Object.values(obj).every(isStrictNode);
}

/**
 * Keywords the strict subset rejects outright.
 *
 * `minLength`/`maxLength` are absent from OpenAI's supported-keyword list —
 * only `pattern` and `format` constrain strings there — so a schema carrying
 * them is refused rather than downgraded. Length bounds belong in the executor,
 * which enforces them anyway. Numeric `minimum`/`maximum`, `enum`, `pattern`
 * and `minItems`/`maxItems` are supported and stay in the schema.
 */
const UNSUPPORTED_STRICT_KEYWORDS = [
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  '$ref',
  'minLength',
  'maxLength',
] as const;

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
