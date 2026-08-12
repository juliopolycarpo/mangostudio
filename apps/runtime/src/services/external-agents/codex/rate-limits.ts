/**
 * Codex account rate-limit mapping and sparse-merge.
 *
 * Vendor reset times are Unix **seconds**. Conversion to milliseconds happens
 * exactly once here — the shared contract's `…AtMs` fields assert that. A
 * double conversion produces dates decades in the future.
 *
 * Sparse-merge rules (from the vendor's own notification prose):
 * - An absent field retains the previous value.
 * - An explicitly-null field does NOT clear a previously observed value.
 * - Spend-control `None` (null) means unavailable, not a sparse-update recovery.
 * - A sparse update alone, with no prior `account/rateLimits/read` baseline,
 *   must not produce a displayed snapshot.
 */

import type {
  ExternalAccountLimits,
  ExternalAgentTargetId,
  ExternalCredits,
  ExternalRateLimitBucket,
  ExternalRateLimitById,
  ExternalRateLimitWindow,
  ExternalResetCredit,
  ExternalResetCredits,
  ExternalSpendControl,
} from '@mangostudio/shared/external-agents';
import type { AccountRateLimitsUpdatedNotification } from './protocol/v2/AccountRateLimitsUpdatedNotification';
import type { CreditsSnapshot } from './protocol/v2/CreditsSnapshot';
import type { GetAccountRateLimitsResponse } from './protocol/v2/GetAccountRateLimitsResponse';
import type { RateLimitResetCredit } from './protocol/v2/RateLimitResetCredit';
import type { RateLimitResetCreditsSummary } from './protocol/v2/RateLimitResetCreditsSummary';
import type { RateLimitSnapshot } from './protocol/v2/RateLimitSnapshot';
import type { RateLimitWindow } from './protocol/v2/RateLimitWindow';
import type { SpendControlLimitSnapshot } from './protocol/v2/SpendControlLimitSnapshot';

/** Unix seconds → epoch milliseconds. Call exactly once per vendor timestamp. */
export function codexUnixSecondsToMs(seconds: number): number {
  return seconds * 1_000;
}

function mapWindow(
  window: RateLimitWindow | null | undefined,
  label?: string | null
): ExternalRateLimitWindow | undefined {
  if (window == null) return undefined;
  return {
    ...(label && label.length > 0 ? { label } : {}),
    usedPercent: window.usedPercent,
    ...(window.windowDurationMins != null ? { windowDurationMins: window.windowDurationMins } : {}),
    ...(window.resetsAt != null ? { resetsAtMs: codexUnixSecondsToMs(window.resetsAt) } : {}),
  };
}

function mapCredits(credits: CreditsSnapshot | null | undefined): ExternalCredits | undefined {
  if (credits == null) return undefined;
  return {
    hasCredits: credits.hasCredits,
    unlimited: credits.unlimited,
    ...(credits.balance != null && credits.balance.length > 0 ? { balance: credits.balance } : {}),
  };
}

function mapSpendControl(
  individual: SpendControlLimitSnapshot | null | undefined,
  spendControlReached: boolean | null | undefined
): ExternalSpendControl | undefined {
  // `None` is unavailable, not a sparse-update recovery. When both the limit
  // snapshot and the reached flag are null/absent, omit the whole object.
  if (individual == null && spendControlReached == null) return undefined;
  return {
    ...(individual
      ? {
          limit: individual.limit,
          used: individual.used,
          remainingPercent: individual.remainingPercent,
          resetsAtMs: codexUnixSecondsToMs(individual.resetsAt),
        }
      : {}),
    // Only set when the vendor reported a boolean. Null means unavailable.
    ...(typeof spendControlReached === 'boolean' ? { reached: spendControlReached } : {}),
  };
}

function mapBucket(snapshot: RateLimitSnapshot): ExternalRateLimitBucket {
  const primary = mapWindow(snapshot.primary, snapshot.limitName ?? 'primary');
  const secondary = mapWindow(snapshot.secondary, 'secondary');
  const credits = mapCredits(snapshot.credits);
  const spendControl = mapSpendControl(snapshot.individualLimit, snapshot.spendControlReached);
  return {
    ...(snapshot.limitId != null && snapshot.limitId.length > 0
      ? { limitId: snapshot.limitId }
      : {}),
    ...(snapshot.limitName != null && snapshot.limitName.length > 0
      ? { limitName: snapshot.limitName }
      : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(credits ? { credits } : {}),
    ...(spendControl ? { spendControl } : {}),
    ...(snapshot.planType != null ? { planType: snapshot.planType } : {}),
    ...(snapshot.rateLimitReachedType != null
      ? { reachedType: snapshot.rateLimitReachedType }
      : {}),
  };
}

function mapResetCredit(credit: RateLimitResetCredit): ExternalResetCredit {
  return {
    id: credit.id,
    resetType: credit.resetType,
    status: credit.status,
    grantedAtMs: codexUnixSecondsToMs(credit.grantedAt),
    ...(credit.expiresAt != null ? { expiresAtMs: codexUnixSecondsToMs(credit.expiresAt) } : {}),
    ...(credit.title != null && credit.title.length > 0 ? { title: credit.title } : {}),
    ...(credit.description != null && credit.description.length > 0
      ? { description: credit.description }
      : {}),
  };
}

function mapResetCredits(
  summary: RateLimitResetCreditsSummary | null | undefined
): ExternalResetCredits | undefined {
  if (summary == null) return undefined;
  const availableCount = Number(summary.availableCount);
  return {
    availableCount: Number.isFinite(availableCount) ? Math.max(0, Math.trunc(availableCount)) : 0,
    ...(summary.credits != null ? { credits: summary.credits.map(mapResetCredit) } : {}),
  };
}

function windowsFromBucket(bucket: ExternalRateLimitBucket): ExternalRateLimitWindow[] {
  const windows: ExternalRateLimitWindow[] = [];
  if (bucket.primary) windows.push(bucket.primary);
  if (bucket.secondary) windows.push(bucket.secondary);
  return windows;
}

/**
 * Full baseline from `account/rateLimits/read`. Always produces a snapshot when
 * the vendor answered; callers gate display on this having run at least once.
 */
export function mapAccountRateLimitsResponse(
  response: GetAccountRateLimitsResponse,
  targetId: ExternalAgentTargetId,
  observedAtMs: number
): ExternalAccountLimits {
  const primary = mapBucket(response.rateLimits);
  const byLimitId: ExternalRateLimitById[] = [];
  if (response.rateLimitsByLimitId) {
    for (const [limitId, snapshot] of Object.entries(response.rateLimitsByLimitId)) {
      if (!snapshot) continue;
      byLimitId.push({ limitId, snapshot: mapBucket(snapshot) });
    }
  }

  return {
    targetId,
    windows: windowsFromBucket(primary),
    ...(byLimitId.length > 0 ? { byLimitId } : {}),
    ...(primary.credits ? { credits: primary.credits } : {}),
    ...(mapResetCredits(response.rateLimitResetCredits)
      ? { resetCredits: mapResetCredits(response.rateLimitResetCredits) }
      : {}),
    ...(primary.planType ? { planType: primary.planType } : {}),
    ...(primary.reachedType ? { reachedType: primary.reachedType } : {}),
    observedAtMs,
  };
}

/**
 * Sparse field merge for one window. Null/absent keeps the previous value.
 */
function mergeWindow(
  previous: ExternalRateLimitWindow | undefined,
  next: RateLimitWindow | null | undefined,
  label?: string | null
): ExternalRateLimitWindow | undefined {
  if (next == null) return previous;
  const mapped = mapWindow(next, label);
  if (!mapped) return previous;
  if (!previous) return mapped;
  return {
    ...previous,
    ...mapped,
    // Keep a previous label when the update did not supply one.
    ...(mapped.label ? { label: mapped.label } : previous.label ? { label: previous.label } : {}),
  };
}

function mergeCredits(
  previous: ExternalCredits | undefined,
  next: CreditsSnapshot | null | undefined
): ExternalCredits | undefined {
  if (next == null) return previous;
  const mapped = mapCredits(next);
  if (!mapped) return previous;
  return { ...previous, ...mapped };
}

function mergeSpendControl(
  previous: ExternalSpendControl | undefined,
  individual: SpendControlLimitSnapshot | null | undefined,
  spendControlReached: boolean | null | undefined
): ExternalSpendControl | undefined {
  // Null reached flag is unavailable, not a recovery — retain previous.
  if (individual == null && spendControlReached == null) return previous;
  const mapped = mapSpendControl(individual, spendControlReached);
  if (!mapped) return previous;
  return { ...previous, ...mapped };
}

function mergeBucket(
  previous: ExternalRateLimitBucket | undefined,
  next: RateLimitSnapshot
): ExternalRateLimitBucket {
  const base = previous ?? {};
  return {
    ...base,
    ...(next.limitId != null && next.limitId.length > 0
      ? { limitId: next.limitId }
      : base.limitId
        ? { limitId: base.limitId }
        : {}),
    ...(next.limitName != null && next.limitName.length > 0
      ? { limitName: next.limitName }
      : base.limitName
        ? { limitName: base.limitName }
        : {}),
    ...(mergeWindow(base.primary, next.primary, next.limitName ?? base.limitName ?? 'primary')
      ? {
          primary: mergeWindow(
            base.primary,
            next.primary,
            next.limitName ?? base.limitName ?? 'primary'
          ),
        }
      : {}),
    ...(mergeWindow(base.secondary, next.secondary, 'secondary')
      ? { secondary: mergeWindow(base.secondary, next.secondary, 'secondary') }
      : {}),
    ...(mergeCredits(base.credits, next.credits)
      ? { credits: mergeCredits(base.credits, next.credits) }
      : {}),
    ...(mergeSpendControl(base.spendControl, next.individualLimit, next.spendControlReached)
      ? {
          spendControl: mergeSpendControl(
            base.spendControl,
            next.individualLimit,
            next.spendControlReached
          ),
        }
      : {}),
    ...(next.planType != null
      ? { planType: next.planType }
      : base.planType
        ? { planType: base.planType }
        : {}),
    ...(next.rateLimitReachedType != null
      ? { reachedType: next.rateLimitReachedType }
      : base.reachedType
        ? { reachedType: base.reachedType }
        : {}),
  };
}

/**
 * Merge a sparse `account/rateLimits/updated` into a prior baseline.
 *
 * Returns `undefined` when there is no baseline — a sparse update alone must
 * not produce a displayed snapshot.
 */
export function mergeAccountRateLimitsUpdate(
  baseline: ExternalAccountLimits | undefined,
  notification: AccountRateLimitsUpdatedNotification,
  observedAtMs: number
): ExternalAccountLimits | undefined {
  if (!baseline) return undefined;

  const mergedPrimary = mergeBucket(
    {
      primary: baseline.windows[0],
      secondary: baseline.windows[1],
      credits: baseline.credits,
      planType: baseline.planType,
      reachedType: baseline.reachedType,
    },
    notification.rateLimits
  );

  return {
    ...baseline,
    windows: windowsFromBucket(mergedPrimary),
    ...(mergedPrimary.credits ? { credits: mergedPrimary.credits } : {}),
    ...(mergedPrimary.planType ? { planType: mergedPrimary.planType } : {}),
    ...(mergedPrimary.reachedType ? { reachedType: mergedPrimary.reachedType } : {}),
    observedAtMs,
  };
}
