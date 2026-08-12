import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import type { ExternalAccountLimits, ExternalUsage } from '../../src/external-agents';
import { ExternalAccountLimitsSchema, ExternalThreadUsageSchema } from '../../src/external-agents';
import { externalAgentEventToStreamChunk } from '../../src/streaming/external-events';

/**
 * Render contract: only vendor-reported fields appear; no computed totals.
 * Scopes stay separate — per-turn, thread last/total, and account quota.
 */
describe('external usage and limits render contract', () => {
  it('projects per-turn usage without inventing missing fields', () => {
    const usage: ExternalUsage = { inputTokens: 10, outputTokens: 2 };
    const chunk = externalAgentEventToStreamChunk({ type: 'usage', usage });
    expect(chunk).toEqual({ type: 'external_usage', usage, done: false });
    expect(Object.keys(chunk && 'usage' in chunk ? chunk.usage : {})).toEqual([
      'inputTokens',
      'outputTokens',
    ]);
  });

  it('keeps thread last and total as separate scopes', () => {
    const usage = {
      last: { inputTokens: 10, totalTokens: 12 },
      total: { inputTokens: 100, totalTokens: 120 },
    };
    expect(Value.Check(ExternalThreadUsageSchema, usage)).toBe(true);
    const chunk = externalAgentEventToStreamChunk({ type: 'thread_usage', usage });
    expect(chunk?.type).toBe('external_thread_usage');
    if (chunk?.type !== 'external_thread_usage') return;
    // Never fold total into last or invent a sum.
    expect(chunk.usage.last?.totalTokens).toBe(12);
    expect(chunk.usage.total?.totalTokens).toBe(120);
  });

  it('projects account limits as their own scope', () => {
    const limits: ExternalAccountLimits = {
      targetId: 'codex',
      windows: [{ usedPercent: 40, resetsAtMs: 1_700_000_000_000 }],
      observedAtMs: 1_700_000_000_000,
    };
    expect(Value.Check(ExternalAccountLimitsSchema, limits)).toBe(true);
    const chunk = externalAgentEventToStreamChunk({ type: 'account_limits', limits });
    expect(chunk).toEqual({ type: 'external_account_limits', limits, done: false });
  });
});
