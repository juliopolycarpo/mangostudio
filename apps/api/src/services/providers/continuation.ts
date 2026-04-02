/**
 * Canonical continuation envelope: a typed, versioned wrapper around
 * provider-specific state that is persisted between agentic turns.
 *
 * All providers emit this envelope on `turn_completed`. The route-level
 * validation in respond-stream uses it as a safety gate before forwarding
 * state to the provider.
 */

import type { ProviderType } from '@mangostudio/shared/types';
import { computeHash, computeToolsetHash } from '../../utils/hash';

export { computeToolsetHash };

export type ContinuationMode = 'responses' | 'interactions' | 'stateless-loop';

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
 * Returns null on any failure (bad JSON, missing fields, wrong schema version).
 */
export function parseContinuationEnvelope(
  raw: string | null | undefined
): ContinuationEnvelope | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.schemaVersion !== 1) return null;
    if (typeof parsed.provider !== 'string') return null;
    if (typeof parsed.mode !== 'string') return null;
    if (typeof parsed.modelName !== 'string') return null;
    if (typeof parsed.systemPromptHash !== 'string') return null;
    if (typeof parsed.toolsetHash !== 'string') return null;
    return parsed as unknown as ContinuationEnvelope;
  } catch {
    return null;
  }
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
 * Computes a deterministic hash for a system prompt string.
 * Returns a fixed constant for undefined/empty prompts.
 */
export function computeSystemPromptHash(systemPrompt: string | undefined): string {
  if (!systemPrompt || systemPrompt.trim() === '') return 'none';
  return computeHash(systemPrompt);
}
