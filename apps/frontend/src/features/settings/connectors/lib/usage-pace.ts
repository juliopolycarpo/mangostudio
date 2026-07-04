/**
 * Linear burn-pace math for a ChatGPT rate-limit window: percent used versus
 * percent of the window elapsed. Deliberately dumb — MangoStudio only sees the
 * quota when it refreshes, and other apps burn the same quota invisibly, so
 * the pace is a lower bound and anything fancier would imply false precision.
 */

import type { ChatGptUsageSnapshot } from '@mangostudio/shared/connectors';

type UsageWindow = NonNullable<ChatGptUsageSnapshot['primary']>;

export interface BurnPace {
  status: 'onPace' | 'runningHot';
  /** Percent of the window already elapsed (0–100). */
  elapsedPercent: number;
  /**
   * Unix epoch ms when linear extrapolation crosses 100% used, present only
   * when that lands before the window resets.
   */
  projectedExhaustionAt?: number;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Returns null when the window lacks the data to place "now" inside it
 * (no length or no reset time), or when it already reset.
 */
export function computeBurnPace(window: UsageWindow, now: number): BurnPace | null {
  if (window.windowMinutes === undefined || window.resetsAt === undefined) return null;
  const windowMs = window.windowMinutes * 60_000;
  if (windowMs <= 0 || window.resetsAt <= now) return null;

  const elapsedMs = Math.min(windowMs, Math.max(0, now - (window.resetsAt - windowMs)));
  const elapsedPercent = (elapsedMs / windowMs) * 100;
  const usedPercent = clampPercent(window.usedPercent);

  if (usedPercent >= 100) {
    return { status: 'runningHot', elapsedPercent, projectedExhaustionAt: now };
  }
  // A fresh window (nothing elapsed) or an idle one (nothing used) carries no
  // pace signal; both read as on pace.
  if (elapsedMs <= 0 || usedPercent <= elapsedPercent) {
    return { status: 'onPace', elapsedPercent };
  }

  // Burning faster than time passes: linear extrapolation from the window
  // start always crosses 100% before the reset.
  const exhaustionAt = now + (100 - usedPercent) / (usedPercent / elapsedMs);
  return {
    status: 'runningHot',
    elapsedPercent,
    projectedExhaustionAt: Math.min(exhaustionAt, window.resetsAt),
  };
}
