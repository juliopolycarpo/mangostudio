/**
 * Maps Cursor SDK model IDs to MangoStudio ModelInfo entries.
 */

import { getModelContextLimit } from '../core/context-policy';
import type { ModelInfo, ModelParameterInfo } from '../types';

export const CURSOR_FALLBACK_MODELS = ['composer-2.5', 'auto'] as const;

interface CursorModelParameterDefinition {
  id: string;
  values: Array<{ value: string }>;
}

export function normalizeCursorModelParameters(
  definitions: CursorModelParameterDefinition[] | undefined
): ModelParameterInfo[] | undefined {
  if (!definitions?.length) return undefined;

  const parameters = definitions
    .map((definition) => ({
      id: definition.id,
      values: definition.values.map((entry) => entry.value).filter((value) => value.length > 0),
    }))
    .filter((definition) => definition.id.length > 0 && definition.values.length > 0);

  return parameters.length > 0 ? parameters : undefined;
}

export function toCursorModelInfo(
  modelId: string,
  parameterDefinitions?: CursorModelParameterDefinition[]
): ModelInfo {
  const parameters = normalizeCursorModelParameters(parameterDefinitions);
  return {
    modelId,
    displayName: modelId,
    provider: 'cursor',
    inputTokenLimit: getModelContextLimit(modelId),
    ...(parameters ? { parameters } : {}),
    capabilities: {
      text: true,
      image: false,
      streaming: true,
      reasoning: true,
      tools: false,
      internalAgentTools: true,
      statefulContinuation: false,
      promptCaching: false,
      parallelToolCalls: false,
      reasoningWithTools: false,
      structuredOutput: false,
    },
  };
}

export function getCursorFallbackModels(): ModelInfo[] {
  return CURSOR_FALLBACK_MODELS.map((modelId) => toCursorModelInfo(modelId));
}
