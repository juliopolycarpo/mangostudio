import { QUOTA_ACTIVITY_DELTA_POINTS } from '@mangostudio/shared/activity';
import type { ExternalAccountLimits } from '@mangostudio/shared/external-agents';

export interface QuotaActivityDelta {
  readonly previousUsedPercent: number;
  readonly usedPercent: number;
}

/**
 * The move worth a feed row, or `undefined` when there is nothing to report.
 *
 * A snapshot is written after most turns and on every manual refresh, so the
 * reading itself is not news — the `AgentsCard` shows it live. Three things are
 * filtered out: the first snapshot for an account (no previous reading, so no
 * delta), a vendor that reports no metered window, and a move smaller than
 * {@link QUOTA_ACTIVITY_DELTA_POINTS}. A window *reset* is a large negative
 * move and passes, which is the one a returning user most wants to see.
 *
 * The primary window is `windows[0]`: the contract defines that list as ordered,
 * with the backward-compatible single-bucket view first.
 */
export function quotaActivityDelta(
  previous: ExternalAccountLimits | undefined,
  next: ExternalAccountLimits
): QuotaActivityDelta | undefined {
  const previousUsedPercent = previous?.windows[0]?.usedPercent;
  const usedPercent = next.windows[0]?.usedPercent;
  if (previousUsedPercent === undefined || usedPercent === undefined) return undefined;
  if (Math.abs(usedPercent - previousUsedPercent) < QUOTA_ACTIVITY_DELTA_POINTS) return undefined;

  return { previousUsedPercent, usedPercent };
}
