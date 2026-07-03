/**
 * ChatGPT plan-quota telemetry: header/payload parsing and in-memory snapshots.
 *
 * The `x-codex-*` rate-limit headers and the `/wham` payload shapes are
 * unversioned backend internals, so all protocol knowledge stays in this file
 * and every shape is parsed defensively: a malformed or absent field degrades
 * to omission (never an error), and one malformed element never discards its
 * valid siblings.
 */

import type {
  ChatGptRedeemOutcome,
  ChatGptUsageSnapshot,
  ChatGptUsageStats,
  RedeemChatGptResetCreditResponse,
} from '@mangostudio/shared/connectors';

type UsageWindow = NonNullable<ChatGptUsageSnapshot['primary']>;
type AdditionalLimit = NonNullable<ChatGptUsageSnapshot['additionalLimits']>[number];
type ResetCredits = NonNullable<ChatGptUsageSnapshot['resetCredits']>;

/** Default limit family the backend reports headers under. */
const HEADER_LIMIT_ID = 'codex';

/** Snapshots older than this are refreshed on the next status read. */
export const CHATGPT_USAGE_STALE_MS = 5 * 60_000;

/** Coerces a number that may arrive as number or numeric string. */
function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Normalizes an epoch that may be reported in seconds or milliseconds. */
function toEpochMs(value: number): number {
  return value > 1e12 ? value : value * 1000;
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// ---------------------------------------------------------------------------
// Header parsing (passive capture from /responses)
// ---------------------------------------------------------------------------

function parseHeaderWindow(headers: Headers, prefix: string): UsageWindow | undefined {
  const usedPercent = coerceNumber(headers.get(`${prefix}-used-percent`));
  if (usedPercent === undefined) return undefined;

  const window: UsageWindow = { usedPercent };
  const windowMinutes = coerceNumber(headers.get(`${prefix}-window-minutes`));
  if (windowMinutes !== undefined) window.windowMinutes = windowMinutes;
  const resetAt = coerceNumber(headers.get(`${prefix}-reset-at`));
  if (resetAt !== undefined) window.resetsAt = toEpochMs(resetAt);
  return window;
}

/**
 * Parses the `x-codex-*` rate-limit response headers into a snapshot, or null
 * when the response carried no usage telemetry at all.
 */
export function parseChatGptUsageHeaders(
  headers: Headers,
  capturedAt = Date.now()
): ChatGptUsageSnapshot | null {
  const snapshot: ChatGptUsageSnapshot = { capturedAt, source: 'headers' };

  const primary = parseHeaderWindow(headers, `x-${HEADER_LIMIT_ID}-primary`);
  if (primary) snapshot.primary = primary;
  const secondary = parseHeaderWindow(headers, `x-${HEADER_LIMIT_ID}-secondary`);
  if (secondary) snapshot.secondary = secondary;

  const hasCredits = coerceBoolean(headers.get(`x-${HEADER_LIMIT_ID}-credits-has-credits`));
  const unlimited = coerceBoolean(headers.get(`x-${HEADER_LIMIT_ID}-credits-unlimited`));
  const balance = coerceNumber(headers.get(`x-${HEADER_LIMIT_ID}-credits-balance`));
  if (hasCredits !== undefined || unlimited !== undefined || balance !== undefined) {
    snapshot.credits = {
      ...(hasCredits !== undefined ? { hasCredits } : {}),
      ...(unlimited !== undefined ? { unlimited } : {}),
      ...(balance !== undefined ? { balance } : {}),
    };
  }

  const reachedType = headers.get(`x-${HEADER_LIMIT_ID}-rate-limit-reached-type`);
  if (reachedType) snapshot.limitReached = true;

  const promoMessage = headers.get(`x-${HEADER_LIMIT_ID}-promo-message`);
  if (promoMessage) snapshot.promoMessage = promoMessage;

  const hasTelemetry =
    snapshot.primary ||
    snapshot.secondary ||
    snapshot.credits ||
    snapshot.limitReached ||
    snapshot.promoMessage;
  return hasTelemetry ? snapshot : null;
}

// ---------------------------------------------------------------------------
// /wham/usage payload parsing
// ---------------------------------------------------------------------------

function parsePayloadWindow(value: unknown, capturedAt: number): UsageWindow | undefined {
  const record = asRecord(value);
  const usedPercent = coerceNumber(record?.used_percent);
  if (usedPercent === undefined) return undefined;

  const window: UsageWindow = { usedPercent };
  const windowSeconds = coerceNumber(record?.limit_window_seconds);
  if (windowSeconds !== undefined) window.windowMinutes = windowSeconds / 60;
  const resetAt = coerceNumber(record?.reset_at);
  const resetAfterSeconds = coerceNumber(record?.reset_after_seconds);
  if (resetAt !== undefined) {
    window.resetsAt = toEpochMs(resetAt);
  } else if (resetAfterSeconds !== undefined) {
    window.resetsAt = capturedAt + resetAfterSeconds * 1000;
  }
  return window;
}

/** Lossy per-element parse: a malformed entry never discards valid siblings. */
function parseAdditionalLimits(value: unknown, capturedAt: number): AdditionalLimit[] {
  if (!Array.isArray(value)) return [];

  const limits: AdditionalLimit[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const limitName = typeof record.limit_name === 'string' ? record.limit_name : undefined;
    const rateLimit = asRecord(record.rate_limit);
    const window = parsePayloadWindow(rateLimit?.primary_window, capturedAt);
    if (limitName === undefined && window === undefined) continue;
    limits.push({
      ...(limitName !== undefined ? { limitName } : {}),
      ...(window !== undefined ? { window } : {}),
    });
  }
  return limits;
}

/**
 * Parses a `GET /wham/usage` payload into a snapshot, or null when the payload
 * is not an object.
 */
export function parseChatGptUsagePayload(
  payload: unknown,
  capturedAt = Date.now()
): ChatGptUsageSnapshot | null {
  const record = asRecord(payload);
  if (!record) return null;

  const snapshot: ChatGptUsageSnapshot = { capturedAt, source: 'endpoint' };

  if (typeof record.plan_type === 'string' && record.plan_type) {
    snapshot.planType = record.plan_type;
  }

  const rateLimit = asRecord(record.rate_limit);
  const primary = parsePayloadWindow(rateLimit?.primary_window, capturedAt);
  if (primary) snapshot.primary = primary;
  const secondary = parsePayloadWindow(rateLimit?.secondary_window, capturedAt);
  if (secondary) snapshot.secondary = secondary;

  const limitReached =
    coerceBoolean(rateLimit?.limit_reached) ??
    (typeof record.rate_limit_reached_type === 'string' && record.rate_limit_reached_type
      ? true
      : undefined);
  if (limitReached !== undefined) snapshot.limitReached = limitReached;

  const credits = asRecord(record.credits);
  if (credits) {
    const hasCredits = coerceBoolean(credits.has_credits);
    const unlimited = coerceBoolean(credits.unlimited);
    const balance = coerceNumber(credits.balance);
    if (hasCredits !== undefined || unlimited !== undefined || balance !== undefined) {
      snapshot.credits = {
        ...(hasCredits !== undefined ? { hasCredits } : {}),
        ...(unlimited !== undefined ? { unlimited } : {}),
        ...(balance !== undefined ? { balance } : {}),
      };
    }
  }

  const resetCredits = asRecord(record.rate_limit_reset_credits);
  const availableCount = coerceNumber(resetCredits?.available_count);
  if (availableCount !== undefined) {
    snapshot.resetCredits = { availableCount };
  }

  const additionalLimits = parseAdditionalLimits(record.additional_rate_limits, capturedAt);
  if (additionalLimits.length > 0) snapshot.additionalLimits = additionalLimits;

  return snapshot;
}

// ---------------------------------------------------------------------------
// /wham/rate-limit-reset-credits payload parsing
// ---------------------------------------------------------------------------

/**
 * Parses a `GET /wham/rate-limit-reset-credits` payload. Unknown credit
 * statuses are treated as opaque (not available), and a credit whose
 * `expires_at` is already past is skipped for "next expiring" even when its
 * status still says available.
 */
export function parseChatGptResetCreditsPayload(
  payload: unknown,
  now = Date.now()
): ResetCredits | null {
  const record = asRecord(payload);
  if (!record) return null;

  const entries = Array.isArray(record.credits) ? record.credits : [];
  let availableFromList = 0;
  let nextExpiresAt: number | undefined;
  for (const entry of entries) {
    const credit = asRecord(entry);
    if (credit?.status !== 'available') continue;
    availableFromList += 1;
    if (typeof credit.expires_at !== 'string') continue;
    const expiresAt = Date.parse(credit.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
    if (nextExpiresAt === undefined || expiresAt < nextExpiresAt) nextExpiresAt = expiresAt;
  }

  const availableCount = coerceNumber(record.available_count) ?? availableFromList;
  return {
    availableCount,
    ...(nextExpiresAt !== undefined ? { nextExpiresAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// /wham/rate-limit-reset-credits/consume payload parsing
// ---------------------------------------------------------------------------

const REDEEM_OUTCOMES: readonly ChatGptRedeemOutcome[] = [
  'reset',
  'nothing_to_reset',
  'no_credit',
  'already_redeemed',
];

function isRedeemOutcome(value: unknown): value is ChatGptRedeemOutcome {
  return typeof value === 'string' && (REDEEM_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Parses a `POST /wham/rate-limit-reset-credits/consume` payload. Returns null
 * for an unknown outcome code — a redemption spends a scarce user perk, so an
 * unrecognized outcome must surface as an error, never be guessed at.
 */
export function parseChatGptRedeemResponse(
  payload: unknown
): RedeemChatGptResetCreditResponse | null {
  const record = asRecord(payload);
  if (!record || !isRedeemOutcome(record.code)) return null;
  return { code: record.code, windowsReset: coerceNumber(record.windows_reset) ?? 0 };
}

// ---------------------------------------------------------------------------
// /wham/profiles/me payload parsing
// ---------------------------------------------------------------------------

/**
 * Parses the `stats` block of a `GET /wham/profiles/me` payload into usage
 * stats, or null when the payload carries no stats at all. Daily buckets are
 * parsed lossily per element and sorted ascending by date.
 */
export function parseChatGptProfileStats(payload: unknown): ChatGptUsageStats | null {
  const stats = asRecord(asRecord(payload)?.stats);
  if (!stats) return null;

  const result: ChatGptUsageStats = {};
  const lifetimeTokens = coerceNumber(stats.lifetime_tokens);
  if (lifetimeTokens !== undefined) result.lifetimeTokens = lifetimeTokens;
  const peakDailyTokens = coerceNumber(stats.peak_daily_tokens);
  if (peakDailyTokens !== undefined) result.peakDailyTokens = peakDailyTokens;
  const longestRunningTurnSec = coerceNumber(stats.longest_running_turn_sec);
  if (longestRunningTurnSec !== undefined) result.longestRunningTurnSec = longestRunningTurnSec;
  const currentStreakDays = coerceNumber(stats.current_streak_days);
  if (currentStreakDays !== undefined) result.currentStreakDays = currentStreakDays;
  const longestStreakDays = coerceNumber(stats.longest_streak_days);
  if (longestStreakDays !== undefined) result.longestStreakDays = longestStreakDays;

  if (Array.isArray(stats.daily_usage_buckets)) {
    const buckets: NonNullable<ChatGptUsageStats['dailyUsage']> = [];
    for (const entry of stats.daily_usage_buckets) {
      const bucket = asRecord(entry);
      const tokens = coerceNumber(bucket?.tokens);
      if (typeof bucket?.start_date !== 'string' || bucket.start_date === '') continue;
      if (tokens === undefined) continue;
      buckets.push({ startDate: bucket.start_date, tokens });
    }
    if (buckets.length > 0) {
      buckets.sort((a, b) => a.startDate.localeCompare(b.startDate));
      result.dailyUsage = buckets;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ---------------------------------------------------------------------------
// In-memory snapshot store (keyed by ChatGPT account id)
// ---------------------------------------------------------------------------

const usageStore = new Map<string, ChatGptUsageSnapshot>();

/**
 * Records a snapshot; between capture paths, the newest `capturedAt` wins.
 * A promo message is sticky: the header only appears occasionally, so a newer
 * snapshot without one keeps the last seen message until a newer header
 * replaces it (dismissal is a frontend concern).
 */
export function recordChatGptUsageSnapshot(
  accountId: string,
  snapshot: ChatGptUsageSnapshot
): void {
  const existing = usageStore.get(accountId);
  if (existing && existing.capturedAt > snapshot.capturedAt) return;
  if (existing?.promoMessage && snapshot.promoMessage === undefined) {
    usageStore.set(accountId, { ...snapshot, promoMessage: existing.promoMessage });
    return;
  }
  usageStore.set(accountId, snapshot);
}

export function getChatGptUsageSnapshot(accountId: string): ChatGptUsageSnapshot | null {
  return usageStore.get(accountId) ?? null;
}

export function isChatGptUsageStale(snapshot: ChatGptUsageSnapshot, now = Date.now()): boolean {
  return now - snapshot.capturedAt > CHATGPT_USAGE_STALE_MS;
}

/** Passive capture hook for `/responses` (and other backend) response headers. */
export function captureChatGptUsageHeaders(accountId: string, headers: Headers): void {
  const snapshot = parseChatGptUsageHeaders(headers);
  if (snapshot) recordChatGptUsageSnapshot(accountId, snapshot);
}

export function resetChatGptUsageStoreForTests(): void {
  usageStore.clear();
}
