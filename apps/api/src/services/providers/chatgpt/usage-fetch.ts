/**
 * On-demand ChatGPT plan-usage fetch against the `/wham` backend endpoints.
 *
 * Both calls are best-effort with a short timeout: usage must be visible
 * before the first generation and refreshable from Settings, but a slow or
 * broken backend must never break a status read — every failure degrades to
 * the last stored snapshot (or no data).
 */

import type { ChatGptUsageSnapshot } from '@mangostudio/shared/connectors';
import { getConfig } from '../../../lib/config';
import type { ChatGptTokenBundle } from '../../../modules/connectors/infrastructure/chatgpt/oauth-client';
import { withAbortTimeout } from '../core/probe-timeout';
import { buildChatGptHeaders } from './client';
import {
  getChatGptUsageSnapshot,
  isChatGptUsageStale,
  parseChatGptResetCreditsPayload,
  parseChatGptUsagePayload,
  recordChatGptUsageSnapshot,
} from './usage';

/** CodexBar uses 4s on these endpoints; they answer fast or not at all. */
const WHAM_FETCH_TIMEOUT_MS = 4_000;

/**
 * The `/wham` endpoints live at the backend-api root, one level above the
 * Codex-scoped Responses base URL.
 */
function whamUrl(path: string): string {
  const root = getConfig().chatgpt.apiBaseUrl.replace(/\/codex\/?$/, '');
  return `${root}/wham/${path}`;
}

async function fetchWhamJson(bundle: ChatGptTokenBundle, path: string): Promise<unknown> {
  const response = await withAbortTimeout(
    (signal) =>
      fetch(whamUrl(path), {
        headers: {
          Authorization: `Bearer ${bundle.accessToken}`,
          ...buildChatGptHeaders(bundle),
        },
        signal,
      }),
    `ChatGPT usage fetch timed out (${path}).`,
    WHAM_FETCH_TIMEOUT_MS
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
