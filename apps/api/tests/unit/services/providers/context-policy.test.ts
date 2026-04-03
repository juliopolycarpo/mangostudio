import { describe, it, expect } from 'bun:test';
import {
  estimateTokenCount,
  getModelContextLimit,
  computeContextSnapshot,
  recommendContextAction,
  getContextSeverity,
  type ContextSnapshot,
} from '../../../../src/services/providers/context-policy';

describe('estimateTokenCount', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  it('estimates ~4 chars per token', () => {
    expect(estimateTokenCount('abcd')).toBe(1);
    expect(estimateTokenCount('abcde')).toBe(2);
  });

  it('returns reasonable value for a typical prompt', () => {
    const text = 'Hello, how are you today?'; // 25 chars → ~7 tokens
    const estimate = estimateTokenCount(text);
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(text.length);
  });
});

describe('getModelContextLimit', () => {
  it('returns 1M for gpt-4o models', () => {
    expect(getModelContextLimit('gpt-4o')).toBe(1_048_576);
    expect(getModelContextLimit('gpt-4o-mini')).toBe(1_048_576);
  });

  it('returns 1M for gpt-4.1 models', () => {
    expect(getModelContextLimit('gpt-4.1')).toBe(1_048_576);
  });

  it('returns 1M for gpt-5 models', () => {
    expect(getModelContextLimit('gpt-5')).toBe(1_048_576);
  });

  it('returns 200k for o-series reasoning models', () => {
    expect(getModelContextLimit('o1')).toBe(200_000);
    expect(getModelContextLimit('o3-mini')).toBe(200_000);
    expect(getModelContextLimit('o4-mini')).toBe(200_000);
  });

  it('returns 1M for gemini-2.5 models', () => {
    expect(getModelContextLimit('gemini-2.5-pro')).toBe(1_048_576);
    expect(getModelContextLimit('gemini-2.5-flash')).toBe(1_048_576);
  });

  it('returns 1M for gemini-2.0 models', () => {
    expect(getModelContextLimit('gemini-2.0-flash')).toBe(1_048_576);
  });

  it('returns 200k for claude-3 models', () => {
    expect(getModelContextLimit('claude-3-opus-20240229')).toBe(200_000);
    expect(getModelContextLimit('claude-3-5-sonnet-20241022')).toBe(200_000);
  });

  it('returns 200k for claude-sonnet/opus/haiku aliases', () => {
    expect(getModelContextLimit('claude-sonnet-4-5')).toBe(200_000);
    expect(getModelContextLimit('claude-opus-4-6')).toBe(200_000);
    expect(getModelContextLimit('claude-haiku-4-5')).toBe(200_000);
  });

  it('returns 1M for legacy gemini-pro (catch-all)', () => {
    expect(getModelContextLimit('gemini-pro')).toBe(1_048_576);
    expect(getModelContextLimit('gemini-pro-vision')).toBe(1_048_576);
  });

  it('returns 128k fallback for unknown models', () => {
    expect(getModelContextLimit('unknown-model-xyz')).toBe(128_000);
    expect(getModelContextLimit('')).toBe(128_000);
  });
});

describe('computeContextSnapshot', () => {
  const baseParams = {
    modelName: 'gpt-4o',
    history: [] as any[],
    mode: 'stateful' as const,
  };

  it('prefers provider-reported tokens over local estimate', () => {
    const snapshot = computeContextSnapshot({
      ...baseParams,
      providerReportedTokens: 50_000,
    });
    expect(snapshot.estimatedInputTokens).toBe(50_000);
    expect(snapshot.providerReportedInputTokens).toBe(50_000);
    expect(snapshot.estimatedUsageRatio).toBeCloseTo(50_000 / 1_048_576, 5);
  });

  it('computes local estimate when no provider data', () => {
    const snapshot = computeContextSnapshot({
      ...baseParams,
      systemPrompt: 'You are a helpful assistant.',
      history: [{ id: '1', role: 'user', text: 'Hello world' }],
    });
    expect(snapshot.estimatedInputTokens).toBeGreaterThan(0);
    expect(snapshot.providerReportedInputTokens).toBeUndefined();
    expect(snapshot.contextLimit).toBe(1_048_576);
    expect(snapshot.estimatedUsageRatio).toBeGreaterThan(0);
    expect(snapshot.estimatedUsageRatio).toBeLessThanOrEqual(1);
  });

  it('includes tool definitions in local estimate', () => {
    const snapshotWithTools = computeContextSnapshot({
      ...baseParams,
      toolDefinitions: [
        {
          name: 'search',
          description: 'Search the web',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
    });
    const snapshotWithoutTools = computeContextSnapshot({ ...baseParams });
    expect(snapshotWithTools.estimatedInputTokens).toBeGreaterThan(
      snapshotWithoutTools.estimatedInputTokens
    );
  });

  it('caps estimatedUsageRatio at 1', () => {
    const snapshot = computeContextSnapshot({
      ...baseParams,
      providerReportedTokens: 999_999_999,
    });
    expect(snapshot.estimatedUsageRatio).toBe(1);
  });

  it('preserves the mode field', () => {
    const snapshot = computeContextSnapshot({ ...baseParams, mode: 'replay' });
    expect(snapshot.mode).toBe('replay');
  });

  it('uses contextLimitOverride when provided', () => {
    const snapshot = computeContextSnapshot({
      ...baseParams,
      providerReportedTokens: 50_000,
      contextLimitOverride: 1_000_000,
    });
    expect(snapshot.contextLimit).toBe(1_000_000);
    expect(snapshot.estimatedUsageRatio).toBeCloseTo(50_000 / 1_000_000, 5);
  });

  it('falls back to getModelContextLimit when no override', () => {
    const snapshot = computeContextSnapshot({
      ...baseParams,
      providerReportedTokens: 50_000,
    });
    // gpt-4o → 1_048_576
    expect(snapshot.contextLimit).toBe(1_048_576);
  });
});

describe('recommendContextAction', () => {
  const makeSnapshot = (
    ratio: number,
    mode: 'stateful' | 'replay' = 'stateful'
  ): ContextSnapshot => ({
    estimatedInputTokens: Math.round(ratio * 1_000_000),
    contextLimit: 1_000_000,
    estimatedUsageRatio: ratio,
    mode,
  });

  it('returns continue_stateful below 92% when stateful', () => {
    expect(recommendContextAction(makeSnapshot(0.5))).toBe('continue_stateful');
    expect(recommendContextAction(makeSnapshot(0.69))).toBe('continue_stateful');
    expect(recommendContextAction(makeSnapshot(0.91))).toBe('continue_stateful');
  });

  it('returns continue_replay below 92% when replay mode', () => {
    expect(recommendContextAction(makeSnapshot(0.5, 'replay'))).toBe('continue_replay');
    expect(recommendContextAction(makeSnapshot(0.91, 'replay'))).toBe('continue_replay');
  });

  it('returns compact_then_continue between 92% and 96%', () => {
    expect(recommendContextAction(makeSnapshot(0.92))).toBe('compact_then_continue');
    expect(recommendContextAction(makeSnapshot(0.96))).toBe('compact_then_continue');
  });

  it('returns hard_stop at 97% and above', () => {
    expect(recommendContextAction(makeSnapshot(0.97))).toBe('hard_stop');
    expect(recommendContextAction(makeSnapshot(1.0))).toBe('hard_stop');
  });
});

describe('getContextSeverity', () => {
  it('returns normal below 70%', () => {
    expect(getContextSeverity(0)).toBe('normal');
    expect(getContextSeverity(0.69)).toBe('normal');
  });

  it('returns info between 70% and 84%', () => {
    expect(getContextSeverity(0.7)).toBe('info');
    expect(getContextSeverity(0.84)).toBe('info');
  });

  it('returns warning between 85% and 91%', () => {
    expect(getContextSeverity(0.85)).toBe('warning');
    expect(getContextSeverity(0.91)).toBe('warning');
  });

  it('returns danger between 92% and 96%', () => {
    expect(getContextSeverity(0.92)).toBe('danger');
    expect(getContextSeverity(0.96)).toBe('danger');
  });

  it('returns critical at 97% and above', () => {
    expect(getContextSeverity(0.97)).toBe('critical');
    expect(getContextSeverity(1.0)).toBe('critical');
  });
});
