import { describe, expect, it } from 'bun:test';
import { computeBurnPace } from '@/features/settings/connectors/lib/usage-pace';

const NOW = 1_700_000_000_000;
const WEEK_MINUTES = 7 * 24 * 60;
const WEEK_MS = WEEK_MINUTES * 60_000;

/** A weekly window with `elapsedMs` already behind us. */
function weeklyWindow(usedPercent: number, elapsedMs: number) {
  return { usedPercent, windowMinutes: WEEK_MINUTES, resetsAt: NOW + WEEK_MS - elapsedMs };
}

describe('computeBurnPace', () => {
  it('returns null without window length or reset time', () => {
    expect(computeBurnPace({ usedPercent: 50 }, NOW)).toBeNull();
    expect(computeBurnPace({ usedPercent: 50, windowMinutes: 300 }, NOW)).toBeNull();
    expect(computeBurnPace({ usedPercent: 50, resetsAt: NOW + 1000 }, NOW)).toBeNull();
  });

  it('returns null for an already reset window', () => {
    expect(
      computeBurnPace({ usedPercent: 50, windowMinutes: 300, resetsAt: NOW - 1 }, NOW)
    ).toBeNull();
  });

  it('reads on pace when usage trails elapsed time', () => {
    const pace = computeBurnPace(weeklyWindow(25, WEEK_MS / 2), NOW);
    expect(pace).toMatchObject({ status: 'onPace' });
    expect(pace?.elapsedPercent).toBeCloseTo(50);
    expect(pace?.projectedExhaustionAt).toBeUndefined();
  });

  it('reads a fresh window as on pace regardless of usage', () => {
    const pace = computeBurnPace(weeklyWindow(40, 0), NOW);
    expect(pace).toMatchObject({ status: 'onPace', elapsedPercent: 0 });
  });

  it('reads an idle window (0% used) as on pace', () => {
    const pace = computeBurnPace(weeklyWindow(0, WEEK_MS * 0.9), NOW);
    expect(pace).toMatchObject({ status: 'onPace' });
  });

  it('projects exhaustion before reset when burning faster than time passes', () => {
    // Half the window gone, 80% used: linear pace exhausts at 62.5% elapsed.
    const pace = computeBurnPace(weeklyWindow(80, WEEK_MS / 2), NOW);
    expect(pace?.status).toBe('runningHot');
    expect(pace?.projectedExhaustionAt).toBeCloseTo(NOW + WEEK_MS / 8, -3);
  });

  it('clamps over-100% usage to exhausted now', () => {
    const pace = computeBurnPace(weeklyWindow(120, WEEK_MS / 2), NOW);
    expect(pace).toMatchObject({ status: 'runningHot', projectedExhaustionAt: NOW });
  });

  it('never projects past the reset time', () => {
    const pace = computeBurnPace(weeklyWindow(99.999, 1), NOW);
    expect(pace?.status).toBe('runningHot');
    expect(pace?.projectedExhaustionAt).toBeLessThanOrEqual(NOW + WEEK_MS - 1);
  });
});
