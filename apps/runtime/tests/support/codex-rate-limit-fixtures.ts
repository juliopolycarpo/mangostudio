/**
 * Fixtures derived from the pinned Codex `GetAccountRateLimitsResponse` /
 * `RateLimitSnapshot` types — not hand-invented shapes (plan 012 / D12).
 */

import type { AccountRateLimitsUpdatedNotification } from '../../src/services/external-agents/codex/protocol/v2/AccountRateLimitsUpdatedNotification';
import type { GetAccountRateLimitsResponse } from '../../src/services/external-agents/codex/protocol/v2/GetAccountRateLimitsResponse';
import type { RateLimitSnapshot } from '../../src/services/external-agents/codex/protocol/v2/RateLimitSnapshot';
import type { RateLimitWindow } from '../../src/services/external-agents/codex/protocol/v2/RateLimitWindow';

/** A known Unix-seconds reset time used by the unit assertion. */
export const FIXTURE_RESETS_AT_SECONDS = 1_700_000_000;
export const FIXTURE_RESETS_AT_MS = FIXTURE_RESETS_AT_SECONDS * 1_000;

export function rateLimitWindow(overrides: Partial<RateLimitWindow> = {}): RateLimitWindow {
  return {
    usedPercent: 42,
    windowDurationMins: 300,
    resetsAt: FIXTURE_RESETS_AT_SECONDS,
    ...overrides,
  };
}

export function rateLimitSnapshot(overrides: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot {
  return {
    limitId: 'codex',
    limitName: 'Codex',
    primary: rateLimitWindow(),
    secondary: rateLimitWindow({ usedPercent: 10, windowDurationMins: 10_080 }),
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: 'plus',
    rateLimitReachedType: null,
    ...overrides,
  };
}

/** Full baseline as `account/rateLimits/read` returns it. */
export function getAccountRateLimitsResponse(
  overrides: Partial<GetAccountRateLimitsResponse> = {}
): GetAccountRateLimitsResponse {
  return {
    rateLimits: rateLimitSnapshot(),
    rateLimitsByLimitId: { codex: rateLimitSnapshot() },
    rateLimitResetCredits: {
      availableCount: 2n,
      credits: [
        {
          id: 'credit-1',
          resetType: 'codexRateLimits',
          status: 'available',
          grantedAt: FIXTURE_RESETS_AT_SECONDS - 86_400,
          expiresAt: FIXTURE_RESETS_AT_SECONDS + 86_400,
          title: 'Reset credit',
          description: null,
        },
      ],
    },
    ...overrides,
  };
}

export function accountRateLimitsUpdated(
  overrides: Partial<RateLimitSnapshot> = {}
): AccountRateLimitsUpdatedNotification {
  return { rateLimits: rateLimitSnapshot(overrides) };
}
