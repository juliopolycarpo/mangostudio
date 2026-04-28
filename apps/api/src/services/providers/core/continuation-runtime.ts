/**
 * Continuation runtime — pure decision engine for cross-turn provider state.
 *
 * Splits continuation into three concepts:
 *   - `durableCursorState`  — persisted across turns (responses, interactions)
 *   - `turnLocalTrace`      — kept in memory within one request only (stateless-loop)
 *   - `contextSnapshot`     — ephemeral context info for UI display
 *
 * The runtime answers one question before every provider call:
 *   "Given the last persisted state and the current turn context, how should
 *    we continue?"
 *
 * It returns a typed `ContinuationDecision` that the orchestrator translates
 * into wire params, SSE events, and persistence actions.
 */

import type { ProviderType } from '@mangostudio/shared/types';
import {
  parseContinuationEnvelope,
  validateContinuationEnvelope,
  isDurableMode,
  type ContinuationMode,
  type ContinuationEnvelope,
} from './continuation-envelope';

export type ContinuationDecision =
  | { type: 'continue_with_cursor'; providerState: string; envelope: ContinuationEnvelope }
  | { type: 'degrade_to_replay'; reason: string; previousMode: ContinuationMode }
  | { type: 'start_replay' }
  | { type: 'abort_unsafe_tool_replay'; reason: string };

export interface ContinuationStrategy {
  provider: ProviderType;
  durableMode: ContinuationMode | null;
  replayMode: 'replay' | 'stateless-loop';
  supportsDurableCursor: boolean;
  supportsProviderCompaction: boolean;
}

export const CONTINUATION_STRATEGIES: Record<ProviderType, ContinuationStrategy> = {
  openai: {
    provider: 'openai',
    durableMode: 'responses',
    replayMode: 'replay',
    supportsDurableCursor: true,
    supportsProviderCompaction: true,
  },
  gemini: {
    provider: 'gemini',
    durableMode: 'interactions',
    replayMode: 'replay',
    supportsDurableCursor: true,
    supportsProviderCompaction: false,
  },
  'openai-compatible': {
    provider: 'openai-compatible',
    durableMode: null,
    replayMode: 'stateless-loop',
    supportsDurableCursor: false,
    supportsProviderCompaction: false,
  },
  anthropic: {
    provider: 'anthropic',
    durableMode: null,
    replayMode: 'stateless-loop',
    supportsDurableCursor: false,
    supportsProviderCompaction: false,
  },
};

export function getContinuationStrategy(provider: ProviderType): ContinuationStrategy {
  return CONTINUATION_STRATEGIES[provider];
}

export interface DecideContinuationInput {
  lastProviderState: string | null;
  provider: ProviderType;
  modelName: string;
  systemPromptHash: string;
  toolsetHash: string;
}

/**
 * Decides how to continue a chat turn given the previously persisted provider
 * state and the current execution context.
 *
 * Pure function — no side effects, no I/O.
 */
export function decideContinuation(input: DecideContinuationInput): ContinuationDecision {
  const { lastProviderState, provider, modelName, systemPromptHash, toolsetHash } = input;

  if (!lastProviderState) {
    return { type: 'start_replay' };
  }

  const envelope = parseContinuationEnvelope(lastProviderState);
  if (!envelope) {
    const strategy = getContinuationStrategy(provider);
    return {
      type: 'degrade_to_replay',
      reason: 'malformed or invalid envelope',
      previousMode: strategy.durableMode ?? 'stateless-loop',
    };
  }

  const validation = validateContinuationEnvelope(envelope, {
    provider,
    modelName,
    systemPromptHash,
    toolsetHash,
  });

  if (!validation.valid) {
    return {
      type: 'degrade_to_replay',
      reason: validation.reason ?? 'unknown',
      previousMode: envelope.mode,
    };
  }

  if (isDurableMode(envelope.mode) && envelope.cursor) {
    return { type: 'continue_with_cursor', providerState: lastProviderState, envelope };
  }

  return { type: 'start_replay' };
}

/**
 * Returns true when the given providerState is a durable cursor that matches
 * the expected mode for the current provider.
 *
 * This is stricter than `isDurableMode` alone because it also checks the
 * provider field, preventing a mismatched durable envelope from being persisted.
 */
export function isDurableCursorForProvider(
  providerState: string | null,
  provider: ProviderType
): boolean {
  const envelope = parseContinuationEnvelope(providerState);
  if (!envelope) return false;

  const strategy = getContinuationStrategy(provider);
  if (!strategy.durableMode) return false;

  return (
    envelope.provider === provider && envelope.mode === strategy.durableMode && !!envelope.cursor
  );
}
