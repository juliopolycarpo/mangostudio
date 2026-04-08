/**
 * Context window estimation and policy recommendations.
 *
 * Provides pre-call token estimates, model-specific context limits,
 * severity bands for UI display, and action recommendations.
 */

import type { ChatTurnContext, ToolDefinition } from './types';

/** Continuation modes visible to the user. */
export type ContinuationDisplayMode = 'stateful' | 'replay' | 'compacted' | 'degraded';

/** Snapshot of context window usage for a single turn. */
export interface ContextSnapshot {
  estimatedInputTokens: number;
  providerReportedInputTokens?: number;
  contextLimit: number;
  estimatedUsageRatio: number;
  mode: ContinuationDisplayMode;
}

/** Policy action recommended by the context engine. */
export type ContextAction =
  | 'continue_stateful'
  | 'continue_replay'
  | 'compact_then_continue'
  | 'summarize_then_continue'
  | 'hard_stop';

/**
 * Rough token estimate. ~4 chars per token for English.
 * Providers report exact counts after the call; this is a pre-call estimate.
 *
 * Known limitations:
 *   - Undercounts CJK (Chinese/Japanese/Korean) text, where 1 character ≈ 1-2 tokens.
 *   - Overcounts for code, where tokens often map to whole keywords or symbols.
 *   - Does not account for special tokens (BOS, EOS, role separators).
 * For accuracy, use tiktoken or a provider-specific tokenizer.
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Curated per-model context input token limits.
 * Keys are lowercase exact model IDs. Tier-1 in the three-tier lookup.
 *
 * Sources:
 *   OpenAI:    https://platform.openai.com/docs/models
 *   Gemini:    https://ai.google.dev/gemini-api/docs/models
 *   DeepSeek:  https://api-docs.deepseek.com/
 *   Anthropic: https://docs.anthropic.com/en/docs/about-claude/models
 */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // OpenAI GPT-4o family
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4o-2024-05-13': 128_000,
  'gpt-4o-2024-08-06': 128_000,
  'gpt-4o-2024-11-20': 128_000,
  'gpt-4o-mini-2024-07-18': 128_000,
  // OpenAI GPT-4.1 family — 1M input
  'gpt-4.1': 1_048_576,
  'gpt-4.1-mini': 1_048_576,
  'gpt-4.1-nano': 1_048_576,
  // OpenAI GPT-4 legacy
  'gpt-4-turbo': 128_000,
  'gpt-4-turbo-preview': 128_000,
  'gpt-4-turbo-2024-04-09': 128_000,
  'gpt-4-0125-preview': 128_000,
  'gpt-4-1106-preview': 128_000,
  'gpt-4': 8_192,
  // OpenAI GPT-3.5
  'gpt-3.5-turbo': 16_385,
  'gpt-3.5-turbo-0125': 16_385,
  // OpenAI o-series
  o1: 200_000,
  'o1-2024-12-17': 200_000,
  'o1-mini': 128_000,
  'o1-mini-2024-09-12': 128_000,
  'o1-preview': 128_000,
  'o1-preview-2024-09-12': 128_000,
  o3: 200_000,
  'o3-mini': 200_000,
  'o3-mini-2025-01-31': 200_000,
  'o4-mini': 200_000,
  'o4-mini-2025-04-16': 200_000,
  // Gemini 2.5
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-pro-exp-03-25': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-flash-preview-04-17': 1_048_576,
  // Gemini 2.0
  'gemini-2.0-flash': 1_048_576,
  'gemini-2.0-flash-001': 1_048_576,
  'gemini-2.0-flash-exp': 1_048_576,
  'gemini-2.0-flash-thinking-exp': 1_048_576,
  'gemini-2.0-flash-lite': 1_048_576,
  // Gemini 1.5 — Pro has 2M input, Flash has 1M
  'gemini-1.5-pro': 2_097_152,
  'gemini-1.5-pro-001': 2_097_152,
  'gemini-1.5-pro-002': 2_097_152,
  'gemini-1.5-flash': 1_048_576,
  'gemini-1.5-flash-001': 1_048_576,
  'gemini-1.5-flash-002': 1_048_576,
  'gemini-1.5-flash-8b': 1_048_576,
  // DeepSeek
  'deepseek-chat': 65_536,
  'deepseek-coder': 65_536,
  'deepseek-r1': 65_536,
  'deepseek-r1-distill-qwen-32b': 65_536,
  'deepseek-r1-distill-llama-70b': 65_536,
  'deepseek-reasoner': 65_536,
  // Anthropic Claude 3+
  'claude-3-opus-20240229': 200_000,
  'claude-3-sonnet-20240229': 200_000,
  'claude-3-haiku-20240307': 200_000,
  'claude-3-5-sonnet-20240620': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
  'claude-3-7-sonnet-20250219': 200_000,
};

/**
 * Returns the known input token context limit for a model using a three-tier lookup:
 *   1. Exact match in the curated MODEL_CONTEXT_LIMITS table
 *   2. Prefix match against curated table keys (longest matching prefix wins)
 *   3. Legacy prefix heuristics (broad families)
 *
 * Falls back to 128k for unknown models.
 */
export function getModelContextLimit(modelName: string): number {
  const lower = modelName.toLowerCase();

  // Tier 1: exact match in curated table
  if (Object.prototype.hasOwnProperty.call(MODEL_CONTEXT_LIMITS, lower)) {
    return MODEL_CONTEXT_LIMITS[lower];
  }

  // Tier 2: longest prefix match in curated table
  let bestMatchLength = 0;
  let bestMatchLimit: number | undefined;
  for (const key of Object.keys(MODEL_CONTEXT_LIMITS)) {
    if (lower.startsWith(key) && key.length > bestMatchLength) {
      bestMatchLength = key.length;
      bestMatchLimit = MODEL_CONTEXT_LIMITS[key];
    }
  }
  if (bestMatchLimit !== undefined) {
    return bestMatchLimit;
  }

  // Tier 3: legacy prefix heuristics for broad model families not in curated table

  // OpenAI GPT-4o, GPT-4.1, GPT-5 → 1M
  if (lower.startsWith('gpt-4o') || lower.startsWith('gpt-4.1') || lower.startsWith('gpt-5')) {
    return 1_048_576;
  }

  // OpenAI o-series reasoning models → 200k
  if (lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) {
    return 200_000;
  }

  // Gemini 2.5 / 2.0 / 1.5 → 1M
  if (
    lower.startsWith('gemini-2.5') ||
    lower.startsWith('gemini-2.0') ||
    lower.startsWith('gemini-1.5')
  ) {
    return 1_048_576;
  }

  // Catch-all for any other Gemini model (e.g. legacy gemini-pro) → 1M
  if (lower.startsWith('gemini')) {
    return 1_048_576;
  }

  // Claude 3+ models → 200k
  if (
    lower.startsWith('claude-3') ||
    lower.startsWith('claude-sonnet') ||
    lower.startsWith('claude-opus') ||
    lower.startsWith('claude-haiku')
  ) {
    return 200_000;
  }

  // Default fallback
  return 128_000;
}

/** Compute a context snapshot from available data. */
export function computeContextSnapshot(params: {
  modelName: string;
  history: ChatTurnContext[];
  systemPrompt?: string;
  toolDefinitions?: ToolDefinition[];
  providerReportedTokens?: number;
  mode: ContinuationDisplayMode;
  /** When provided, overrides the hardcoded limit from getModelContextLimit. */
  contextLimitOverride?: number;
}): ContextSnapshot {
  const contextLimit = params.contextLimitOverride ?? getModelContextLimit(params.modelName);

  // If the provider reported tokens, prefer that
  if (params.providerReportedTokens != null) {
    const ratio = params.providerReportedTokens / contextLimit;
    return {
      estimatedInputTokens: params.providerReportedTokens,
      providerReportedInputTokens: params.providerReportedTokens,
      contextLimit,
      estimatedUsageRatio: Math.min(ratio, 1),
      mode: params.mode,
    };
  }

  // Otherwise estimate locally
  let totalChars = 0;
  if (params.systemPrompt) totalChars += params.systemPrompt.length;
  for (const turn of params.history) {
    totalChars += turn.text.length;
  }
  if (params.toolDefinitions) {
    totalChars += JSON.stringify(params.toolDefinitions).length;
  }
  const estimated = Math.ceil(totalChars / 4);
  const ratio = estimated / contextLimit;

  return {
    estimatedInputTokens: estimated,
    contextLimit,
    estimatedUsageRatio: Math.min(ratio, 1),
    mode: params.mode,
  };
}

/**
 * Recommend an action based on context pressure.
 *
 * Thresholds (product defaults):
 *   0-69%   → normal (continue as-is)
 *   70-84%  → informational (continue, maybe log)
 *   85-91%  → warning (continue but warn user)
 *   92-96%  → degradation risk (consider compaction)
 *   97%+    → hard protection (stop or compact)
 */
export function recommendContextAction(snapshot: ContextSnapshot): ContextAction {
  const ratio = snapshot.estimatedUsageRatio;
  if (ratio < 0.92) {
    return snapshot.mode === 'stateful' ? 'continue_stateful' : 'continue_replay';
  }
  if (ratio < 0.97) {
    return 'compact_then_continue';
  }
  return 'hard_stop';
}

/** Threshold category for UI display. */
export type ContextSeverity = 'normal' | 'info' | 'warning' | 'danger' | 'critical';

export function getContextSeverity(ratio: number): ContextSeverity {
  if (ratio < 0.7) return 'normal';
  if (ratio < 0.85) return 'info';
  if (ratio < 0.92) return 'warning';
  if (ratio < 0.97) return 'danger';
  return 'critical';
}
