/**
 * Canonical continuation envelope: a typed, versioned wrapper around
 * provider-specific state that is persisted between agentic turns.
 *
 * All providers emit this envelope on `turn_completed`. The route-level
 * validation in respond-stream uses it as a safety gate before forwarding
 * state to the provider.
 *
 * Design notes:
 * - Durable modes (`responses`, `interactions`) require a `cursor` field.
 *   An envelope with a durable mode but no cursor is structurally invalid
 *   and will be rejected by `parseContinuationEnvelope`.
 * - Turn-local mode (`stateless-loop`) must NOT be persisted as cross-turn
 *   state. `isDurableMode` returns false for it.
 * - Unknown mode strings are rejected at parse time so legacy or malformed
 *   state cannot bypass current validation rules.
 */

import type { ProviderType, ContinuationReasonCode } from '@mangostudio/shared/types';
import type { ToolDefinition } from '../types';
import { computeHash, computeToolsetHash } from '../../../utils/hash';
import { parseJsonWith } from '../../../lib/safe-parse';

export { computeToolsetHash };

export type ContinuationMode = 'responses' | 'interactions' | 'stateless-loop';

const VALID_CONTINUATION_MODES = new Set<string>(['responses', 'interactions', 'stateless-loop']);

export interface ContinuationEnvelope {
  schemaVersion: 1;
  provider: ProviderType;
  mode: ContinuationMode;
  modelName: string;
  systemPromptHash: string;
  toolsetHash: string;
  cursor?: string;
  context?: {
    estimatedInputTokens?: number;
    providerReportedInputTokens?: number;
    contextLimit?: number;
    estimatedUsageRatio?: number;
    lastUpdatedAt: number;
  };
}

/**
 * Safely parses a raw JSON string into a ContinuationEnvelope.
 * Returns null on any failure (bad JSON, missing fields, wrong schema version,
 * unrecognised mode, or missing cursor for durable modes).
 */
export function parseContinuationEnvelope(
  raw: string | null | undefined
): ContinuationEnvelope | null {
  return parseJsonWith(raw, (parsed) => {
    if (parsed.schemaVersion !== 1) return null;
    if (typeof parsed.provider !== 'string') return null;
    if (typeof parsed.mode !== 'string') return null;
    if (!VALID_CONTINUATION_MODES.has(parsed.mode)) return null;
    if (typeof parsed.modelName !== 'string') return null;
    if (typeof parsed.systemPromptHash !== 'string') return null;
    if (typeof parsed.toolsetHash !== 'string') return null;
    // Durable modes must carry a cursor; reject silently so callers degrade to replay.
    if (isDurableMode(parsed.mode as ContinuationMode) && typeof parsed.cursor !== 'string') {
      return null;
    }
    return parsed as unknown as ContinuationEnvelope;
  });
}

/** Serializes a ContinuationEnvelope to a JSON string. */
export function serializeContinuationEnvelope(envelope: ContinuationEnvelope): string {
  return JSON.stringify(envelope);
}

export interface ValidationResult {
  valid: boolean;
  /** Human-readable log message — do NOT surface in UI or API responses. */
  reason?: string;
  /** Normalized code for structured event persistence and rendering. */
  reasonCode?: ContinuationReasonCode;
  /** The provider recorded in the envelope (previous provider before a switch). */
  previousProvider?: ProviderType;
}

/**
 * Validates that a parsed envelope is compatible with the current turn context.
 * Checks provider, modelName, systemPromptHash, and toolsetHash.
 */
export function validateContinuationEnvelope(
  envelope: ContinuationEnvelope | null,
  current: {
    provider: ProviderType;
    modelName: string;
    systemPromptHash: string;
    toolsetHash: string;
  }
): ValidationResult {
  if (!envelope)
    return { valid: false, reason: 'envelope is null', reasonCode: 'envelope_malformed' };

  if (envelope.provider !== current.provider) {
    return {
      valid: false,
      reason: `provider changed from "${envelope.provider}" to "${current.provider}"`,
      reasonCode: 'provider_changed',
      previousProvider: envelope.provider,
    };
  }
  if (envelope.modelName !== current.modelName) {
    return {
      valid: false,
      reason: `model changed from "${envelope.modelName}" to "${current.modelName}"`,
      reasonCode: 'model_changed',
      previousProvider: envelope.provider,
    };
  }
  if (envelope.systemPromptHash !== current.systemPromptHash) {
    return {
      valid: false,
      reason: `system prompt changed (hash mismatch)`,
      reasonCode: 'system_prompt_changed',
      previousProvider: envelope.provider,
    };
  }
  if (envelope.toolsetHash !== current.toolsetHash) {
    return {
      valid: false,
      reason: `toolset changed (hash mismatch)`,
      reasonCode: 'toolset_changed',
      previousProvider: envelope.provider,
    };
  }

  return { valid: true };
}

/**
 * Returns true when the continuation mode represents a durable server-side
 * cursor that is valid across separate user turns.
 *
 * Turn-local modes (e.g. stateless-loop) accumulate state within a single
 * agentic turn but must NOT be reused as cross-turn continuation state.
 */
export function isDurableMode(mode: ContinuationMode): boolean {
  return mode === 'responses' || mode === 'interactions';
}

/**
 * Computes a deterministic hash for a system prompt string.
 * Returns a fixed constant for undefined/empty prompts.
 */
export function computeSystemPromptHash(systemPrompt: string | undefined): string {
  if (!systemPrompt || systemPrompt.trim() === '') return 'none';
  return computeHash(systemPrompt);
}

/**
 * Token usage and context information returned by a provider after a turn.
 * Providers populate this from their SDK-specific usage shapes.
 */
export interface ProviderTurnResultContext {
  providerReportedInputTokens?: number;
  contextLimit?: number;
}

/**
 * Separates cross-turn durable state from turn-local loop state within a
 * single agentic request.
 *
 * - `durableProviderState` is the raw JSON string persisted in the chat row.
 *   Durable modes (responses, interactions) carry a server-side cursor that
 *   survives across separate user turns.
 * - `turnLocalState` is the raw JSON string consumed by turn-local providers
 *   (stateless-loop) within one request. It must NOT be persisted cross-turn.
 */
export interface AgentTurnExecutionState {
  durableProviderState: string | null;
  turnLocalState: string | null;
}

/**
 * Builds a `ContinuationEnvelope` from common request metadata.
 *
 * Every provider adapter calls this on `turn_completed` so envelope
 * construction is consistent across the codebase.
 */
export function createContinuationEnvelope(
  provider: ProviderType,
  mode: ContinuationMode,
  options: {
    modelName: string;
    systemPrompt?: string;
    toolDefinitions?: ToolDefinition[];
  },
  cursor?: string,
  context?: { providerReportedInputTokens?: number; contextLimit?: number }
): ContinuationEnvelope {
  return {
    schemaVersion: 1,
    provider,
    mode,
    modelName: options.modelName,
    systemPromptHash: computeSystemPromptHash(options.systemPrompt),
    toolsetHash: computeToolsetHash(options.toolDefinitions ?? []),
    ...(cursor ? { cursor } : {}),
    ...(context
      ? {
          context: {
            ...context,
            lastUpdatedAt: Date.now(),
          },
        }
      : {}),
  };
}
