import { describe, expect, it } from 'bun:test';
import {
  codexUnixSecondsToMs,
  mapAccountRateLimitsResponse,
  mergeAccountRateLimitsUpdate,
} from '../../../src/services/external-agents/codex/rate-limits';
import {
  accountRateLimitsUpdated,
  FIXTURE_RESETS_AT_MS,
  FIXTURE_RESETS_AT_SECONDS,
  getAccountRateLimitsResponse,
  rateLimitSnapshot,
  rateLimitWindow,
} from '../../support/codex-rate-limit-fixtures';

describe('codexUnixSecondsToMs', () => {
  it('converts Unix seconds to milliseconds exactly once', () => {
    expect(codexUnixSecondsToMs(FIXTURE_RESETS_AT_SECONDS)).toBe(FIXTURE_RESETS_AT_MS);
    // A double conversion would land decades in the future.
    const once = codexUnixSecondsToMs(FIXTURE_RESETS_AT_SECONDS);
    const twice = codexUnixSecondsToMs(once);
    expect(twice).toBeGreaterThan(1e15);
    expect(once).toBeLessThan(1e13);
  });
});

describe('mapAccountRateLimitsResponse', () => {
  it('maps a full baseline from the pinned vendor schema', () => {
    const mapped = mapAccountRateLimitsResponse(
      getAccountRateLimitsResponse(),
      'codex',
      1_700_000_100_000
    );
    expect(mapped.targetId).toBe('codex');
    expect(mapped.windows).toHaveLength(2);
    expect(mapped.windows[0]?.resetsAtMs).toBe(FIXTURE_RESETS_AT_MS);
    expect(mapped.windows[0]?.usedPercent).toBe(42);
    expect(mapped.planType).toBe('plus');
    expect(mapped.resetCredits?.availableCount).toBe(2);
    expect(mapped.resetCredits?.credits?.[0]?.grantedAtMs).toBe(
      (FIXTURE_RESETS_AT_SECONDS - 86_400) * 1_000
    );
    expect(mapped.observedAtMs).toBe(1_700_000_100_000);
  });
});

describe('mergeAccountRateLimitsUpdate', () => {
  const baseline = mapAccountRateLimitsResponse(getAccountRateLimitsResponse(), 'codex', 1_000);

  it('requires a baseline — sparse alone produces nothing', () => {
    expect(
      mergeAccountRateLimitsUpdate(undefined, accountRateLimitsUpdated(), 2_000)
    ).toBeUndefined();
  });

  it('retains previous values when a field is absent', () => {
    const sparse = accountRateLimitsUpdated({
      primary: rateLimitWindow({ usedPercent: 90, windowDurationMins: null, resetsAt: null }),
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: null,
      rateLimitReachedType: null,
      limitId: null,
      limitName: null,
    });
    const merged = mergeAccountRateLimitsUpdate(baseline, sparse, 2_000);
    expect(merged?.windows[0]?.usedPercent).toBe(90);
    // Secondary was null in the update — retain previous.
    expect(merged?.windows[1]?.usedPercent).toBe(10);
    expect(merged?.planType).toBe('plus');
    expect(merged?.observedAtMs).toBe(2_000);
  });

  it('overwrites a present field', () => {
    const merged = mergeAccountRateLimitsUpdate(
      baseline,
      accountRateLimitsUpdated({
        primary: rateLimitWindow({ usedPercent: 77 }),
      }),
      3_000
    );
    expect(merged?.windows[0]?.usedPercent).toBe(77);
  });

  it('does not clear a previously observed value when a field is explicitly null', () => {
    const merged = mergeAccountRateLimitsUpdate(
      baseline,
      accountRateLimitsUpdated({
        primary: null,
        secondary: null,
        planType: null,
        rateLimitReachedType: null,
      }),
      4_000
    );
    expect(merged?.windows[0]?.usedPercent).toBe(42);
    expect(merged?.windows[1]?.usedPercent).toBe(10);
    expect(merged?.planType).toBe('plus');
  });

  it('treats spend-control None as unavailable, not recovered', () => {
    const withSpend = mapAccountRateLimitsResponse(
      getAccountRateLimitsResponse({
        rateLimits: rateLimitSnapshot({
          individualLimit: {
            limit: '100',
            used: '80',
            remainingPercent: 20,
            resetsAt: FIXTURE_RESETS_AT_SECONDS,
          },
          spendControlReached: true,
        }),
      }),
      'codex',
      1_000
    );
    expect(withSpend.spendControl).toEqual({
      limit: '100',
      used: '80',
      remainingPercent: 20,
      resetsAtMs: FIXTURE_RESETS_AT_MS,
      reached: true,
    });
    const merged = mergeAccountRateLimitsUpdate(
      withSpend,
      accountRateLimitsUpdated({
        individualLimit: null,
        spendControlReached: null,
      }),
      5_000
    );
    // Null means unavailable — retain previous spend-control state.
    expect(merged?.spendControl).toEqual({
      limit: '100',
      used: '80',
      remainingPercent: 20,
      resetsAtMs: FIXTURE_RESETS_AT_MS,
      reached: true,
    });
    expect(merged?.planType).toBe('plus');
    expect(merged?.windows[0]?.usedPercent).toBe(42);
  });

  it('ignores a malformed rateLimits notification instead of throwing', () => {
    expect(
      mergeAccountRateLimitsUpdate(baseline, { rateLimits: null } as never, 6_000)
    ).toBeUndefined();
    expect(mergeAccountRateLimitsUpdate(baseline, {} as never, 6_000)).toBeUndefined();
  });
});
