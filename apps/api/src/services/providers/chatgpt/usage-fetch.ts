/**
 * On-demand ChatGPT plan-usage fetch against the `/wham` backend endpoints.
 *
 * Both calls are best-effort with a short timeout: usage must be visible
 * before the first generation and refreshable from Settings, but a slow or
 * broken backend must never break a status read — every failure degrades to
 * the last stored snapshot (or no data).
 */

import type {
  ChatGptUsageSnapshot,
  ChatGptUsageStats,
  RedeemChatGptResetCreditResponse,
} from '@mangostudio/shared/connectors';
import { getConfig } from '../../../lib/config';
import type { ChatGptTokenBundle } from '../../../modules/connectors/infrastructure/chatgpt/oauth-client';
import { withAbortTimeout } from '../core/probe-timeout';
import { buildChatGptHeaders } from './client';
import {
  getChatGptUsageSnapshot,
  isChatGptUsageStale,
  parseChatGptProfileStats,
  parseChatGptRedeemResponse,
  parseChatGptResetCreditsPayload,
  parseChatGptUsagePayload,
  recordChatGptUsageSnapshot,
} from './usage';

/** CodexBar uses 4s on these endpoints; they answer fast or not at all. */
const WHAM_FETCH_TIMEOUT_MS = 4_000;

/**
 * Consuming a reset credit is a deliberate user action that must not be
 * abandoned early — a timeout leaves the user unsure whether the credit was
 * spent (retries reuse the same idempotency key, so retrying is safe).
 */
const WHAM_ACTION_TIMEOUT_MS = 10_000;

/**
 * The `/wham` endpoints live at the backend-api root, one level above the
 * Codex-scoped Responses base URL.
 */
function whamUrl(path: string): string {
  const root = getConfig().chatgpt.apiBaseUrl.replace(/\/codex\/?$/, '');
  return `${root}/wham/${path}`;
}

interface WhamRequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly body?: Record<string, unknown>;
  readonly timeoutMs?: number;
}

async function fetchWhamJson(
  bundle: ChatGptTokenBundle,
  path: string,
  options: WhamRequestOptions = {}
): Promise<unknown> {
  const response = await withAbortTimeout(
    (signal) =>
      fetch(whamUrl(path), {
        method: options.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${bundle.accessToken}`,
          ...buildChatGptHeaders(bundle),
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal,
      }),
    `ChatGPT usage fetch timed out (${path}).`,
    options.timeoutMs ?? WHAM_FETCH_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new Error(`ChatGPT usage fetch failed (HTTP ${response.status}, ${path}).`);
  }
  return response.json();
}

/**
 * Fetches the full quota picture (`/wham/usage` plus the reset-credit list for
 * per-credit expirations), stores the snapshot, and returns it. Returns null
 * on any failure — callers fall back to the last stored snapshot.
 */
export async function fetchChatGptUsage(
  bundle: ChatGptTokenBundle
): Promise<ChatGptUsageSnapshot | null> {
  const capturedAt = Date.now();
  const [usagePayload, creditsPayload] = await Promise.all([
    fetchWhamJson(bundle, 'usage').catch(() => null),
    fetchWhamJson(bundle, 'rate-limit-reset-credits').catch(() => null),
  ]);

  const snapshot = parseChatGptUsagePayload(usagePayload, capturedAt);
  if (!snapshot) return null;

  const resetCredits = parseChatGptResetCreditsPayload(creditsPayload, capturedAt);
  if (resetCredits) snapshot.resetCredits = resetCredits;

  recordChatGptUsageSnapshot(bundle.accountId, snapshot);
  return snapshot;
}

/**
 * Resolves the freshest usage snapshot for an account: the stored one when it
 * is recent, otherwise a best-effort refresh, otherwise whatever stale
 * snapshot is left.
 */
export async function getChatGptUsage(
  bundle: ChatGptTokenBundle
): Promise<ChatGptUsageSnapshot | null> {
  const cached = getChatGptUsageSnapshot(bundle.accountId);
  if (cached && !isChatGptUsageStale(cached)) return cached;
  return (await fetchChatGptUsage(bundle)) ?? cached;
}

/**
 * Redeems one rate-limit reset credit. Unlike the snapshot fetches this is
 * NOT best-effort: any transport failure or unrecognized outcome throws, so
 * the caller can tell the user the redemption state is unknown instead of
 * silently swallowing a spent perk.
 */
export async function consumeChatGptResetCredit(
  bundle: ChatGptTokenBundle,
  redeemRequestId: string
): Promise<RedeemChatGptResetCreditResponse> {
  const payload = await fetchWhamJson(bundle, 'rate-limit-reset-credits/consume', {
    method: 'POST',
    body: { redeem_request_id: redeemRequestId },
    timeoutMs: WHAM_ACTION_TIMEOUT_MS,
  });
  const result = parseChatGptRedeemResponse(payload);
  if (!result) {
    throw new Error('ChatGPT reset-credit redemption returned an unrecognized outcome.');
  }
  return result;
}

/**
 * Fetches per-account token-usage stats (`/wham/profiles/me`). Best-effort:
 * returns null on any failure or when the payload carries no stats — the
 * stats panel is decorative and degrades to its empty state.
 */
export async function fetchChatGptUsageStats(
  bundle: ChatGptTokenBundle
): Promise<ChatGptUsageStats | null> {
  const payload = await fetchWhamJson(bundle, 'profiles/me').catch(() => null);
  return parseChatGptProfileStats(payload);
}
