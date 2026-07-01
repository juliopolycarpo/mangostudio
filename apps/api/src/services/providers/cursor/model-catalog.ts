/**
 * Maps Cursor SDK model IDs to MangoStudio ModelInfo entries.
 */

import { getModelContextLimit } from '../core/context-policy';
import type { ModelInfo } from '../types';

export const CURSOR_FALLBACK_MODELS = ['composer-2.5', 'auto'] as const;

export function toCursorModelInfo(modelId: string): ModelInfo {
  return {
    modelId,
    displayName: modelId,
    provider: 'cursor',
    inputTokenLimit: getModelContextLimit(modelId),
    capabilities: {
      text: true,
      image: false,
      streaming: true,
      reasoning: true,
      tools: false,
      statefulContinuation: false,
      promptCaching: false,
      parallelToolCalls: false,
      reasoningWithTools: false,
      structuredOutput: false,
    },
  };
}

export function getCursorFallbackModels(): ModelInfo[] {
  return CURSOR_FALLBACK_MODELS.map(toCursorModelInfo);
}
