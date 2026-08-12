/**
 * Account-quota helpers shared by hub and frontend.
 *
 * Exhaustion is deliberately conservative: a zero primary window with an
 * available secondary (or reset credits) is not exhaustion, and a stale
 * snapshot is unknown rather than zero. Missing data never becomes zero, and
 * nothing here blocks a turn — the vendor refuses when it must.
 *
 * Browser-safe: no Node builtins.
 */

import {
  EXTERNAL_ACCOUNT_LIMITS_STALE_MS,
  type ExternalAccountLimits,
  type ExternalRateLimitWindow,
} from './schemas';

export type ExternalAccountLimitsFreshness = 'fresh' | 'stale' | 'unknown';

export type ExternalAccountLimitsVerdict =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'stale'; readonly observedAtMs: number }
  | {
      readonly kind: 'ok';
      readonly tightest: ExternalRateLimitWindow;
      readonly exhausted: boolean;
    };

/** True when the snapshot is older than the freshness threshold. */
export function isExternalAccountLimitsStale(
  limits: ExternalAccountLimits,
  nowMs: number,
  staleMs: number = EXTERNAL_ACCOUNT_LIMITS_STALE_MS
): boolean {
  return nowMs - limits.observedAtMs > staleMs;
}

/**
 * The window with the highest used percent among those the vendor reported.
 *
 * Never invents a window. Returns undefined when the snapshot has no windows —
 * which is unknown, not zero.
 */
export function tightestExternalRateLimitWindow(
  limits: ExternalAccountLimits
): ExternalRateLimitWindow | undefined {
  let tightest: ExternalRateLimitWindow | undefined;
  for (const window of limits.windows) {
    if (tightest === undefined || window.usedPercent > tightest.usedPercent) {
      tightest = window;
    }
  }
  return tightest;
}

/**
 * Whether capacity remains beyond a zero primary: secondary windows, credits,
 * or reset credits. A primary at 100% with any of these still available is not
 * exhaustion.
 */
export function externalAccountHasAlternateCapacity(limits: ExternalAccountLimits): boolean {
  if (limits.windows.length > 1) {
    const others = limits.windows.slice(1);
    if (others.some((window) => window.usedPercent < 100)) return true;
  }
  if (limits.credits?.unlimited === true) return true;
  if (limits.credits?.hasCredits === true) return true;
  if ((limits.resetCredits?.availableCount ?? 0) > 0) return true;
  return false;
}

/**
 * Interprets a snapshot for the selector: unknown / stale / ok(+exhausted).
 *
 * Never disables on "primary at zero" alone. Never treats missing data as zero.
 */
export function interpretExternalAccountLimits(
  limits: ExternalAccountLimits | null | undefined,
  nowMs: number,
  staleMs: number = EXTERNAL_ACCOUNT_LIMITS_STALE_MS
): ExternalAccountLimitsVerdict {
  if (!limits) return { kind: 'unknown' };
  if (isExternalAccountLimitsStale(limits, nowMs, staleMs)) {
    return { kind: 'stale', observedAtMs: limits.observedAtMs };
  }
  const tightest = tightestExternalRateLimitWindow(limits);
  if (!tightest) return { kind: 'unknown' };

  const primaryExhausted = tightest.usedPercent >= 100;
  return {
    kind: 'ok',
    tightest,
    exhausted: primaryExhausted && !externalAccountHasAlternateCapacity(limits),
  };
}
