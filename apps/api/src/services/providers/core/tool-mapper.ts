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
 * Converts internal ToolDefinitions to the OpenAI Responses API tool format.
 */
export function toolDefsToResponsesAPI(defs: ToolDefinition[]): Array<Record<string, unknown>> {
  return defs.map((def) => ({
    type: 'function',
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    strict: false,
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
