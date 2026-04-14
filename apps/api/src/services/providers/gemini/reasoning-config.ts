/**
 * Model-family-aware reasoning configuration for Gemini.
 *
 * Gemini 3+ uses `thinkingLevel` (enum: LOW/MEDIUM/HIGH/MINIMAL).
 * Gemini 2.5 uses `thinkingBudget` (integer token count).
 * Sending the wrong parameter shape to a model family causes an API error.
 */

import type { ReasoningEffort } from '@mangostudio/shared';

// ---------------------------------------------------------------------------
// Model-family detection
// ---------------------------------------------------------------------------

type GeminiFamily = 'gemini-2.5' | 'gemini-3';

export function getGeminiFamily(modelName: string): GeminiFamily {
  if (/gemini-2\.5/i.test(modelName)) return 'gemini-2.5';
  return 'gemini-3';
}

// ---------------------------------------------------------------------------
// Text API config (generateContentStream → config.thinkingConfig)
// ---------------------------------------------------------------------------

export interface GeminiTextThinkingConfig {
  includeThoughts: boolean;
  thinkingLevel?: string;
  thinkingBudget?: number;
}

const TEXT_LEVEL_MAP: Record<ReasoningEffort, string> = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
};

const TEXT_BUDGET_MAP: Record<ReasoningEffort, number> = {
  low: 1024,
  medium: 8192,
  high: 24576,
};

function isGemini25Pro(modelName: string): boolean {
  return /gemini-2\.5-pro/i.test(modelName);
}

function isGeminiFlash(modelName: string): boolean {
  return /flash/i.test(modelName);
}

export function buildTextThinkingConfig(
  modelName: string,
  thinkingEnabled: boolean,
  reasoningEffort: ReasoningEffort
): GeminiTextThinkingConfig {
  const family = getGeminiFamily(modelName);

  if (family === 'gemini-2.5') {
    if (!thinkingEnabled) {
      // 2.5 Pro cannot fully disable — use minimum (128)
      // 2.5 Flash/Flash-Lite can disable (budget=0)
      const budget = isGemini25Pro(modelName) ? 128 : 0;
      return { includeThoughts: false, thinkingBudget: budget };
    }
    const budget =
      reasoningEffort === 'high' && isGemini25Pro(modelName)
        ? 32768
        : TEXT_BUDGET_MAP[reasoningEffort];
    return { includeThoughts: true, thinkingBudget: budget };
  }

  // Gemini 3+
  if (!thinkingEnabled) {
    // 3 Pro/3.1 Pro cannot disable — use LOW (minimum)
    // 3 Flash supports MINIMAL (~512 tokens)
    const level = isGeminiFlash(modelName) ? 'MINIMAL' : 'LOW';
    return { includeThoughts: false, thinkingLevel: level };
  }
  return { includeThoughts: true, thinkingLevel: TEXT_LEVEL_MAP[reasoningEffort] };
}

// ---------------------------------------------------------------------------
// Interactions API config (generation_config for interactions.create)
// ---------------------------------------------------------------------------

export interface GeminiInteractionsThinkingConfig {
  thinking_level?: string;
  thinking_budget?: number;
  thinking_summaries?: string;
}

const INTERACTIONS_LEVEL_MAP: Record<ReasoningEffort, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

const INTERACTIONS_BUDGET_MAP: Record<ReasoningEffort, number> = {
  low: 1024,
  medium: 8192,
  high: 24576,
};

export function buildInteractionsThinkingConfig(
  modelName: string,
  thinkingEnabled: boolean,
  reasoningEffort: ReasoningEffort
): GeminiInteractionsThinkingConfig | undefined {
  const family = getGeminiFamily(modelName);

  if (family === 'gemini-2.5') {
    if (!thinkingEnabled) {
      const budget = isGemini25Pro(modelName) ? 128 : 0;
      return { thinking_budget: budget, thinking_summaries: 'auto' };
    }
    const budget =
      reasoningEffort === 'high' && isGemini25Pro(modelName)
        ? 32768
        : INTERACTIONS_BUDGET_MAP[reasoningEffort];
    return { thinking_budget: budget, thinking_summaries: 'auto' };
  }

  // Gemini 3+
  if (!thinkingEnabled) {
    const level = isGeminiFlash(modelName) ? 'minimal' : 'low';
    return { thinking_level: level, thinking_summaries: 'auto' };
  }
  return {
    thinking_level: INTERACTIONS_LEVEL_MAP[reasoningEffort],
    thinking_summaries: 'auto',
  };
}
