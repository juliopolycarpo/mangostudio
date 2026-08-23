/**
 * The quota copy's own clock, as a pure function.
 *
 * Asserted here rather than through a rendered timer: what matters is *when*
 * the pill has to wake, and a schedule is a number, not an observed re-render.
 */

import { describe, expect, it } from 'bun:test';
import type { ExternalAccountLimits } from '@mangostudio/shared/external-agents';
import { EXTERNAL_ACCOUNT_LIMITS_STALE_MS } from '@mangostudio/shared/external-agents';
import { nextAccountLimitsCopyChangeMs } from '@/features/external-agents/account-limits-copy';

const NOW = 1_787_000_000_000;

function limitsFixture(overrides: Partial<ExternalAccountLimits> = {}): ExternalAccountLimits {
  return { targetId: 'codex', windows: [{ usedPercent: 40 }], observedAtMs: NOW, ...overrides };
}

describe('nextAccountLimitsCopyChangeMs', () => {
  it('has nothing to schedule without a snapshot', () => {
    expect(nextAccountLimitsCopyChangeMs(null, NOW)).toBeUndefined();
    expect(nextAccountLimitsCopyChangeMs(undefined, NOW)).toBeUndefined();
  });

  it('wakes on the staleness deadline while the account has room', () => {
    expect(nextAccountLimitsCopyChangeMs(limitsFixture(), NOW)).toBe(
      NOW + EXTERNAL_ACCOUNT_LIMITS_STALE_MS + 1
    );
  });

  it('stops scheduling once the snapshot has already gone stale', () => {
    const limits = limitsFixture({ observedAtMs: NOW - EXTERNAL_ACCOUNT_LIMITS_STALE_MS - 1 });
    expect(nextAccountLimitsCopyChangeMs(limits, NOW)).toBeUndefined();
  });

  it('wakes on the reset when it lands before the staleness deadline', () => {
    const resetsAtMs = NOW + 60_000;
    const limits = limitsFixture({ windows: [{ usedPercent: 100, resetsAtMs }] });
    // Not the 15-minute deadline: the countdown reaches zero long before it.
    expect(nextAccountLimitsCopyChangeMs(limits, NOW)).toBe(resetsAtMs - 30_000);
    // …and once past that boundary, the reset itself.
    expect(nextAccountLimitsCopyChangeMs(limits, resetsAtMs - 20_000)).toBe(resetsAtMs);
  });

  it('wakes each time the rendered minute turns over', () => {
    const resetsAtMs = NOW + 10 * 60_000;
    const limits = limitsFixture({ windows: [{ usedPercent: 100, resetsAtMs }] });
    // "10m" becomes "9m" half a minute before the ninth whole minute remains.
    expect(nextAccountLimitsCopyChangeMs(limits, NOW)).toBe(resetsAtMs - 9 * 60_000 - 30_000);
  });

  it('never schedules a wake that is not in the future', () => {
    const resetsAtMs = NOW + 90_000;
    const limits = limitsFixture({ windows: [{ usedPercent: 100, resetsAtMs }] });
    // Standing exactly on a rounding boundary: the shown number is one instant
    // from turning over, so the wake must still be ahead of now.
    expect(nextAccountLimitsCopyChangeMs(limits, resetsAtMs - 90_000)).toBeGreaterThan(
      resetsAtMs - 90_000
    );
  });

  it('ignores a reset on a window that is not exhausted', () => {
    const limits = limitsFixture({ windows: [{ usedPercent: 40, resetsAtMs: NOW + 60_000 }] });
    // The copy reads "60% left" until the snapshot expires — the reset changes
    // nothing it says.
    expect(nextAccountLimitsCopyChangeMs(limits, NOW)).toBe(
      NOW + EXTERNAL_ACCOUNT_LIMITS_STALE_MS + 1
    );
  });
});
