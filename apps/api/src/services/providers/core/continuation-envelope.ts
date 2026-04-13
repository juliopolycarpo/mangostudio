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

import type { ProviderType } from '@mangostudio/shared/types';
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
): { valid: boolean; reason?: string } {
  if (!envelope) return { valid: false, reason: 'envelope is null' };

  if (envelope.provider !== current.provider) {
    return {
      valid: false,
      reason: `provider changed from "${envelope.provider}" to "${current.provider}"`,
    };
  }
  if (envelope.modelName !== current.modelName) {
    return {
      valid: false,
      reason: `model changed from "${envelope.modelName}" to "${current.modelName}"`,
    };
  }
  if (envelope.systemPromptHash !== current.systemPromptHash) {
    return {
      valid: false,
      reason: `system prompt changed (hash mismatch)`,
    };
  }
  if (envelope.toolsetHash !== current.toolsetHash) {
    return {
      valid: false,
      reason: `toolset changed (hash mismatch)`,
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
