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
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Known context limits by model name prefix.
 * Falls back to 128k for unknown models.
 */
export function getModelContextLimit(modelName: string): number {
  const lower = modelName.toLowerCase();

  // OpenAI GPT-4o, GPT-4.1, GPT-5 → 1M
  if (lower.startsWith('gpt-4o') || lower.startsWith('gpt-4.1') || lower.startsWith('gpt-5')) {
    return 1_048_576;
  }

  // OpenAI o-series reasoning models → 200k
  if (lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) {
    return 200_000;
  }

  // Gemini 2.5 models → 1M
  if (lower.startsWith('gemini-2.5')) {
    return 1_048_576;
  }

  // Gemini 2.0 models → 1M
  if (lower.startsWith('gemini-2.0')) {
    return 1_048_576;
  }

  // Gemini 1.5 models → 1M (Pro) or 1M (Flash)
  if (lower.startsWith('gemini-1.5')) {
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
