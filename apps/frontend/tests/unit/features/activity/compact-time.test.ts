/**
 * The short age printed in an activity row's fixed time column: units from the
 * dictionary, floored, and never negative. The sentence form ("37 minutes ago")
 * is `formatRelativeTime`'s and is still the row's tooltip.
 */

import { describe, expect, it } from 'bun:test';
import { en, ptBR } from '@mangostudio/shared/i18n';
import { compactElapsed } from '../../../../src/features/activity/lib/compact-time';

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(ms: number): number {
  return NOW - ms;
}

describe('compactElapsed', () => {
  const labels = en.home.activity;

  it('says "now" for anything under a minute, including a clock slightly ahead', () => {
    expect(compactElapsed(ago(0), labels, NOW)).toBe('now');
    expect(compactElapsed(ago(59_999), labels, NOW)).toBe('now');
    expect(compactElapsed(NOW + 5_000, labels, NOW)).toBe('now');
  });

  it('counts whole units of the largest size that fits', () => {
    expect(compactElapsed(ago(MINUTE), labels, NOW)).toBe('1m');
    expect(compactElapsed(ago(37 * MINUTE + 40_000), labels, NOW)).toBe('37m');
    expect(compactElapsed(ago(HOUR), labels, NOW)).toBe('1h');
    expect(compactElapsed(ago(16 * HOUR), labels, NOW)).toBe('16h');
    expect(compactElapsed(ago(DAY), labels, NOW)).toBe('1d');
    expect(compactElapsed(ago(2 * DAY + 5 * HOUR), labels, NOW)).toBe('2d');
    expect(compactElapsed(ago(30 * DAY), labels, NOW)).toBe('1mo');
    expect(compactElapsed(ago(400 * DAY), labels, NOW)).toBe('1y');
  });

  it('keeps a month apart from a minute, which one letter would not', () => {
    expect(compactElapsed(ago(5 * MINUTE), labels, NOW)).not.toBe(
      compactElapsed(ago(150 * DAY), labels, NOW)
    );
  });

  it('reads its units from the dictionary it is given', () => {
    expect(compactElapsed(ago(5 * MINUTE), ptBR.home.activity, NOW)).toBe('5min');
    expect(compactElapsed(ago(5 * MINUTE - 1), ptBR.home.activity, NOW)).toBe('4min');
    expect(compactElapsed(ago(10), ptBR.home.activity, NOW)).toBe('agora');
  });
});
