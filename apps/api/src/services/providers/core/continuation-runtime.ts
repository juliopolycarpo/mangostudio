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
  | { type: 'start_replay' };

export interface ContinuationStrategy {
  provider: ProviderType;
  strategy: 'durable-cursor' | 'replay' | 'turn-local';
  supportsDurableCursor: boolean;
  durableMode: ContinuationMode | null;
}

export const CONTINUATION_STRATEGIES: Record<ProviderType, ContinuationStrategy> = {
  openai: {
    provider: 'openai',
    strategy: 'durable-cursor',
    supportsDurableCursor: true,
    durableMode: 'responses',
  },
  gemini: {
    provider: 'gemini',
    strategy: 'durable-cursor',
    supportsDurableCursor: true,
    durableMode: 'interactions',
  },
  'openai-compatible': {
    provider: 'openai-compatible',
    strategy: 'replay',
    supportsDurableCursor: false,
    durableMode: null,
  },
  anthropic: {
    provider: 'anthropic',
    strategy: 'turn-local',
    supportsDurableCursor: false,
    durableMode: null,
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
 * Returns true when the parsed envelope is a durable cursor whose provider
 * matches the current call. The provider check guards against persisting a
 * cursor minted by a different provider after a mid-conversation switch.
 */
export function isDurableEnvelope(
  envelope: ContinuationEnvelope | null,
  provider: ProviderType
): boolean {
  if (!envelope) return false;

  const strategy = getContinuationStrategy(provider);
  if (!strategy.durableMode) return false;

  return (
    envelope.provider === provider && envelope.mode === strategy.durableMode && !!envelope.cursor
  );
}

export interface TurnPersistenceDecision {
  envelope: ContinuationEnvelope | null;
  durableProviderState: string | null;
}

/**
 * Resolves whether the provider state returned by `turn_completed` should be
 * persisted as cross-turn durable state. Stateless-loop and provider-mismatched
 * envelopes are filtered out so they never leak into `chats.lastProviderState`.
 *
 * Pure function — no side effects, no I/O.
 */
export function decideTurnPersistence(
  providerState: string | null,
  provider: ProviderType
): TurnPersistenceDecision {
  const envelope = parseContinuationEnvelope(providerState);
  const durable = isDurableEnvelope(envelope, provider) ? providerState : null;
  return { envelope, durableProviderState: durable };
}
