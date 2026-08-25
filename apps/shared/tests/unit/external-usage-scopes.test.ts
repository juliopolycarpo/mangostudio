import { describe, expect, it } from 'bun:test';
import Value from 'typebox/value';
import type { ExternalAccountLimits, ExternalUsage } from '../../src/external-agents';
import {
  ExternalAccountLimitsSchema,
  ExternalThreadUsageSchema,
  externalContextUsage,
  externalReportedTokens,
} from '../../src/external-agents';
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

  it('measures context against the last request, never the cumulative total', () => {
    const context = externalContextUsage({
      last: { inputTokens: 29_000, outputTokens: 1_200, totalTokens: 30_000 },
      total: { totalTokens: 118_000 },
      contextWindowTokens: 272_000,
    });
    expect(context).toEqual({
      usedTokens: 30_000,
      windowTokens: 272_000,
      ratio: 30_000 / 272_000,
      percent: 11,
      severity: 'normal',
    });
  });

  it('escalates severity on the same bands the hub persists', () => {
    expect(
      externalContextUsage({ last: { totalTokens: 95 }, contextWindowTokens: 100 })?.severity
    ).toBe('danger');
    expect(
      externalContextUsage({ last: { totalTokens: 99 }, contextWindowTokens: 100 })?.severity
    ).toBe('critical');
  });

  it('has no percentage to report without a window or a last request', () => {
    expect(externalContextUsage({ last: { totalTokens: 30_000 } })).toBeNull();
    expect(
      externalContextUsage({ total: { totalTokens: 30_000 }, contextWindowTokens: 1000 })
    ).toBeNull();
    expect(externalContextUsage(null)).toBeNull();
    // A sparse report with nothing countable is not zero usage.
    expect(externalContextUsage({ last: {}, contextWindowTokens: 1000 })).toBeNull();
  });

  it('prefers the vendor total over a sum, and reports nothing for an empty scope', () => {
    // 500 rather than 600: the vendor's own total wins over input + output.
    expect(externalReportedTokens({ inputTokens: 400, outputTokens: 200, totalTokens: 500 })).toBe(
      500
    );
    expect(externalReportedTokens({ inputTokens: 400 })).toBe(400);
    expect(externalReportedTokens({ cacheReadTokens: 10 })).toBeNull();
  });

  it('sums the visible fields only when the vendor reports no total', () => {
    expect(
      externalContextUsage({
        last: { inputTokens: 400, outputTokens: 100 },
        contextWindowTokens: 1000,
      })?.percent
    ).toBe(50);
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

  it('stamps the turn account onto a limits snapshot that names only a target', () => {
    const limits: ExternalAccountLimits = {
      targetId: 'codex',
      windows: [{ usedPercent: 40 }],
      observedAtMs: 1_700_000_000_000,
    };

    // The client keys its cache on the account, and this is the only place the
    // account can come from: the vendor's own event has no room for it.
    expect(
      externalAgentEventToStreamChunk(
        { type: 'account_limits', limits },
        { vendorAccountFingerprint: 'account-a' }
      )
    ).toEqual({
      type: 'external_account_limits',
      limits,
      vendorAccountFingerprint: 'account-a',
      done: false,
    });

    // A vendor with no account to fingerprint sends no field, rather than an
    // empty string a client would have to know to read as "none".
    expect(
      externalAgentEventToStreamChunk(
        { type: 'account_limits', limits },
        { vendorAccountFingerprint: null }
      )
    ).not.toHaveProperty('vendorAccountFingerprint');
  });
});
