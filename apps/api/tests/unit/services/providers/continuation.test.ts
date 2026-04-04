import { describe, expect, it } from 'bun:test';
import {
  parseContinuationEnvelope,
  serializeContinuationEnvelope,
  validateContinuationEnvelope,
  computeSystemPromptHash,
  computeToolsetHash,
  isDurableMode,
  type ContinuationEnvelope,
} from '../../../../src/services/providers/continuation';

const BASE_ENVELOPE: ContinuationEnvelope = {
  schemaVersion: 1,
  provider: 'gemini',
  mode: 'interactions',
  modelName: 'gemini-2.0-flash',
  systemPromptHash: 'abc123',
  toolsetHash: 'def456',
  cursor: 'interaction_xyz',
};

describe('parseContinuationEnvelope', () => {
  it('parses a valid envelope', () => {
    const raw = JSON.stringify(BASE_ENVELOPE);
    const result = parseContinuationEnvelope(raw);
    expect(result).toEqual(BASE_ENVELOPE);
  });

  it('returns null for null input', () => {
    expect(parseContinuationEnvelope(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseContinuationEnvelope(undefined)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseContinuationEnvelope('not json {')).toBeNull();
  });

  it('returns null for wrong schemaVersion', () => {
    const raw = JSON.stringify({ ...BASE_ENVELOPE, schemaVersion: 2 });
    expect(parseContinuationEnvelope(raw)).toBeNull();
  });

  it('returns null for missing required fields', () => {
    const { provider: _, ...incomplete } = BASE_ENVELOPE;
    expect(parseContinuationEnvelope(JSON.stringify(incomplete))).toBeNull();
  });
});

describe('serializeContinuationEnvelope + parseContinuationEnvelope', () => {
  it('round-trips to identity', () => {
    const serialized = serializeContinuationEnvelope(BASE_ENVELOPE);
    const parsed = parseContinuationEnvelope(serialized);
    expect(parsed).toEqual(BASE_ENVELOPE);
  });
});

describe('validateContinuationEnvelope', () => {
  const current = {
    provider: 'gemini' as const,
    modelName: 'gemini-2.0-flash',
    systemPromptHash: 'abc123',
    toolsetHash: 'def456',
  };

  it('returns valid for matching envelope', () => {
    const result = validateContinuationEnvelope(BASE_ENVELOPE, current);
    expect(result).toEqual({ valid: true });
  });

  it('returns invalid for null envelope', () => {
    const result = validateContinuationEnvelope(null, current);
    expect(result.valid).toBe(false);
  });

  it('detects provider mismatch', () => {
    const envelope = { ...BASE_ENVELOPE, provider: 'openai' as const };
    const result = validateContinuationEnvelope(envelope, current);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('provider');
  });

  it('detects model mismatch', () => {
    const envelope = { ...BASE_ENVELOPE, modelName: 'gemini-2.5-pro' };
    const result = validateContinuationEnvelope(envelope, current);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('model');
  });

  it('detects systemPromptHash mismatch', () => {
    const envelope = { ...BASE_ENVELOPE, systemPromptHash: 'different' };
    const result = validateContinuationEnvelope(envelope, current);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('system');
  });

  it('detects toolsetHash mismatch', () => {
    const envelope = { ...BASE_ENVELOPE, toolsetHash: 'different' };
    const result = validateContinuationEnvelope(envelope, current);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('toolset');
  });
});

describe('computeSystemPromptHash', () => {
  it('is deterministic for the same input', () => {
    const hash1 = computeSystemPromptHash('You are a helpful assistant.');
    const hash2 = computeSystemPromptHash('You are a helpful assistant.');
    expect(hash1).toBe(hash2);
  });

  it('differs for different inputs', () => {
    const hash1 = computeSystemPromptHash('Prompt A');
    const hash2 = computeSystemPromptHash('Prompt B');
    expect(hash1).not.toBe(hash2);
  });

  it('returns "none" for undefined', () => {
    expect(computeSystemPromptHash(undefined)).toBe('none');
  });

  it('returns "none" for empty string', () => {
    expect(computeSystemPromptHash('')).toBe('none');
  });

  it('returns "none" for whitespace-only string', () => {
    expect(computeSystemPromptHash('   ')).toBe('none');
  });
});

describe('isDurableMode', () => {
  it('returns true for responses', () => {
    expect(isDurableMode('responses')).toBe(true);
  });

  it('returns true for interactions', () => {
    expect(isDurableMode('interactions')).toBe(true);
  });

  it('returns false for stateless-loop', () => {
    expect(isDurableMode('stateless-loop')).toBe(false);
  });
});

describe('computeToolsetHash', () => {
  it('is deterministic for the same input', () => {
    const tools = [{ name: 'tool_a', description: 'A tool', parameters: { type: 'object' } }];
    expect(computeToolsetHash(tools)).toBe(computeToolsetHash(tools));
  });

  it('is order-independent (sorted by name)', () => {
    const toolA = { name: 'a', description: 'A', parameters: {} };
    const toolB = { name: 'b', description: 'B', parameters: {} };
    expect(computeToolsetHash([toolA, toolB])).toBe(computeToolsetHash([toolB, toolA]));
  });
});
