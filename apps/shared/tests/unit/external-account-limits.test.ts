import { describe, expect, it } from 'bun:test';
import {
  EXTERNAL_ACCOUNT_LIMITS_STALE_MS,
  type ExternalAccountLimits,
  externalAccountHasAlternateCapacity,
  interpretExternalAccountLimits,
  isExternalAccountLimitsStale,
  tightestExternalRateLimitWindow,
} from '../../src/external-agents';

const NOW = 1_700_000_000_000;

function limits(
  overrides: Partial<ExternalAccountLimits> &
    Pick<ExternalAccountLimits, 'windows' | 'observedAtMs'>
): ExternalAccountLimits {
  return {
    targetId: 'codex',
    ...overrides,
  };
}

describe('external account limits interpretation', () => {
  it('treats missing data as unknown, never zero', () => {
    expect(interpretExternalAccountLimits(undefined, NOW)).toEqual({ kind: 'unknown' });
    expect(interpretExternalAccountLimits(limits({ windows: [], observedAtMs: NOW }), NOW)).toEqual(
      { kind: 'unknown' }
    );
  });

  it('renders a stale snapshot as stale, not zero', () => {
    const stale = limits({
      windows: [{ usedPercent: 99, resetsAtMs: NOW + 60_000 }],
      observedAtMs: NOW - EXTERNAL_ACCOUNT_LIMITS_STALE_MS - 1,
    });
    expect(isExternalAccountLimitsStale(stale, NOW)).toBe(true);
    expect(interpretExternalAccountLimits(stale, NOW)).toEqual({
      kind: 'stale',
      observedAtMs: stale.observedAtMs,
    });
  });

  it('does not treat zero primary with available secondary as exhaustion', () => {
    const snapshot = limits({
      windows: [
        { label: 'primary', usedPercent: 100, resetsAtMs: NOW + 60_000 },
        { label: 'secondary', usedPercent: 40, resetsAtMs: NOW + 86_400_000 },
      ],
      observedAtMs: NOW,
    });
    expect(externalAccountHasAlternateCapacity(snapshot)).toBe(true);
    const verdict = interpretExternalAccountLimits(snapshot, NOW);
    expect(verdict.kind).toBe('ok');
    if (verdict.kind === 'ok') {
      expect(verdict.exhausted).toBe(false);
      expect(verdict.tightest.usedPercent).toBe(100);
    }
  });

  it('does not treat secondary at 100% as exhaustion when primary still has capacity', () => {
    const snapshot = limits({
      windows: [
        { label: 'primary', usedPercent: 40, resetsAtMs: NOW + 60_000 },
        { label: 'secondary', usedPercent: 100, resetsAtMs: NOW + 86_400_000 },
      ],
      observedAtMs: NOW,
    });
    expect(externalAccountHasAlternateCapacity(snapshot)).toBe(true);
    const verdict = interpretExternalAccountLimits(snapshot, NOW);
    expect(verdict.kind).toBe('ok');
    if (verdict.kind === 'ok') {
      expect(verdict.exhausted).toBe(false);
      expect(verdict.tightest.usedPercent).toBe(100);
    }
  });

  it('marks genuinely exhausted accounts and keeps the reset time', () => {
    const snapshot = limits({
      windows: [{ label: 'primary', usedPercent: 100, resetsAtMs: NOW + 3_600_000 }],
      observedAtMs: NOW,
      reachedType: 'rate_limit_reached',
    });
    expect(externalAccountHasAlternateCapacity(snapshot)).toBe(false);
    const verdict = interpretExternalAccountLimits(snapshot, NOW);
    expect(verdict.kind).toBe('ok');
    if (verdict.kind === 'ok') {
      expect(verdict.exhausted).toBe(true);
      expect(verdict.tightest.resetsAtMs).toBe(NOW + 3_600_000);
    }
  });

  it('picks the tightest reported window without inventing totals', () => {
    const snapshot = limits({
      windows: [{ usedPercent: 10 }, { usedPercent: 55 }, { usedPercent: 30 }],
      observedAtMs: NOW,
    });
    expect(tightestExternalRateLimitWindow(snapshot)?.usedPercent).toBe(55);
  });
});
