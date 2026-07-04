/**
 * Durable write-behind for ChatGPT usage snapshots: one row per observed
 * used-percent change per rate-limit window, keyed by ChatGPT account id
 * (usage windows are account-scoped, so history survives reconnecting a
 * connector). Persistence is best-effort — a database hiccup must never
 * break a status read or a streaming response.
 */

import type {
  ChatGptUsageSample,
  ChatGptUsageSnapshot,
  ChatGptUsageWindowKey,
} from '@mangostudio/shared/connectors';
import { getDb } from '../../../db/database';
import { createDiagnosticLogger } from '../../../lib/logger';

/** Samples older than this are pruned on every persist. */
export const USAGE_SAMPLE_RETENTION_MS = 90 * 24 * 60 * 60_000;

const WINDOW_KEYS: readonly ChatGptUsageWindowKey[] = ['primary', 'secondary'];

const logger = createDiagnosticLogger('chatgpt-usage-samples');

/**
 * Persists the windows of a snapshot as history samples. Dedupe: a window is
 * skipped when its used-percent is unchanged since the last stored sample, or
 * when the snapshot is older than that sample (out-of-order capture paths).
 */
export async function persistChatGptUsageSamples(
  accountId: string,
  snapshot: ChatGptUsageSnapshot
): Promise<void> {
  try {
    const db = getDb();
    for (const windowKey of WINDOW_KEYS) {
      const window = snapshot[windowKey];
      if (!window) continue;

      const last = await db
        .selectFrom('connector_usage_samples')
        .select(['usedPercent', 'sampledAt'])
        .where('accountId', '=', accountId)
        .where('window', '=', windowKey)
        .orderBy('sampledAt', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (
        last &&
        (last.sampledAt >= snapshot.capturedAt || last.usedPercent === window.usedPercent)
      ) {
        continue;
      }

      await db
        .insertInto('connector_usage_samples')
        .values({
          id: crypto.randomUUID(),
          accountId,
          window: windowKey,
          usedPercent: window.usedPercent,
          windowMinutes: window.windowMinutes ?? null,
          resetsAt: window.resetsAt ?? null,
          sampledAt: snapshot.capturedAt,
        })
        .execute();
    }

    await db
      .deleteFrom('connector_usage_samples')
      .where('sampledAt', '<', Date.now() - USAGE_SAMPLE_RETENTION_MS)
      .execute();
  } catch (error) {
    logger.warn('persist failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Lists one window's samples since `sinceMs`, ascending by `sampledAt`. */
export async function listChatGptUsageSamples(
  accountId: string,
  window: ChatGptUsageWindowKey,
  sinceMs: number
): Promise<ChatGptUsageSample[]> {
  const rows = await getDb()
    .selectFrom('connector_usage_samples')
    .select(['usedPercent', 'windowMinutes', 'resetsAt', 'sampledAt'])
    .where('accountId', '=', accountId)
    .where('window', '=', window)
    .where('sampledAt', '>=', sinceMs)
    .orderBy('sampledAt', 'asc')
    .execute();

  return rows.map((row) => ({
    usedPercent: row.usedPercent,
    ...(row.windowMinutes !== null ? { windowMinutes: row.windowMinutes } : {}),
    ...(row.resetsAt !== null ? { resetsAt: row.resetsAt } : {}),
    sampledAt: row.sampledAt,
  }));
}
