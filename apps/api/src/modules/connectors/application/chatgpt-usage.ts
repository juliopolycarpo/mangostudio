/**
 * Use cases: act on a ChatGPT connector's plan quota — redeem a rate-limit
 * reset credit and read per-account token-usage stats.
 */

import type {
  ChatGptUsageHistoryResponse,
  ChatGptUsageStats,
  ChatGptUsageWindowKey,
  RedeemChatGptResetCreditResponse,
} from '@mangostudio/shared/connectors';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import {
  consumeChatGptResetCredit,
  fetchChatGptUsage,
  fetchChatGptUsageStats,
} from '../../../services/providers/chatgpt/usage-fetch';
import { listChatGptUsageSamples } from '../../../services/providers/chatgpt/usage-sample-store';
import { getChatGptTokenService } from '../infrastructure/chatgpt/token-service';
import { getSecretMetadataById } from '../infrastructure/connector-repository';
import { ConnectorNotFoundError } from './connector-errors';

/** The ChatGPT backend rejected or garbled a usage action. */
export class ChatGptUsageActionError extends Error {
  readonly code = ERROR_CODES.PROVIDER_ERROR;
  readonly status = 502;

  constructor(message: string) {
    super(message);
    this.name = 'ChatGptUsageActionError';
  }
}

async function requireChatGptConnector(
  userId: string,
  connectorId: string
): Promise<SecretMetadataRow> {
  const meta = await getSecretMetadataById(connectorId, userId);
  if (meta?.provider !== 'chatgpt') throw new ConnectorNotFoundError();
  return meta;
}

/**
 * Redeems one rate-limit reset credit for a ChatGPT connector. The caller
 * supplies the idempotency key so retries of the same confirmed click can
 * never double-spend. After any outcome the quota snapshot is refreshed
 * best-effort so the next connector listing reflects the redemption.
 */
export async function redeemChatGptResetCredit(
  userId: string,
  connectorId: string,
  redeemRequestId: string
): Promise<RedeemChatGptResetCreditResponse> {
  const meta = await requireChatGptConnector(userId, connectorId);
  const bundle = await getChatGptTokenService().ensureFreshTokens(meta);

  let result: RedeemChatGptResetCreditResponse;
  try {
    result = await consumeChatGptResetCredit(bundle, redeemRequestId);
  } catch (error) {
    throw new ChatGptUsageActionError(
      error instanceof Error ? error.message : 'ChatGPT reset-credit redemption failed.'
    );
  }

  await fetchChatGptUsage(bundle).catch(() => null);
  return result;
}

/**
 * Reads the persisted usage-sample series of one rate-limit window for a
 * ChatGPT connector. Samples are account-scoped, so the connector is resolved
 * to its ChatGPT account without touching the backend.
 */
export async function getChatGptUsageHistory(
  userId: string,
  connectorId: string,
  window: ChatGptUsageWindowKey,
  days: number
): Promise<ChatGptUsageHistoryResponse> {
  const meta = await requireChatGptConnector(userId, connectorId);
  const bundle = await getChatGptTokenService().readBundle(meta.id);
  const sinceMs = Date.now() - days * 24 * 60 * 60_000;
  return {
    window,
    days,
    samples: await listChatGptUsageSamples(bundle.accountId, window, sinceMs),
  };
}

/**
 * Reads token-usage stats for a ChatGPT connector. Null means the backend
 * reported no stats (or an unrecognized shape) — the panel shows its empty
 * state rather than an error.
 */
export async function getChatGptUsageStats(
  userId: string,
  connectorId: string
): Promise<ChatGptUsageStats | null> {
  const meta = await requireChatGptConnector(userId, connectorId);
  const bundle = await getChatGptTokenService().ensureFreshTokens(meta);
  return fetchChatGptUsageStats(bundle);
}
