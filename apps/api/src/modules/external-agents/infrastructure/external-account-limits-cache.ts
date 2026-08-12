/**
 * Discardable cache of vendor account rate-limit snapshots.
 *
 * Keyed on `(userId, environmentId, targetId, vendorAccountFingerprint)` so two
 * environments or two vendor accounts never share a snapshot. Fingerprint null
 * is stored as the empty string — SQLite primary keys cannot hold null.
 */

import type {
  ExternalAccountLimits,
  ExternalAgentTargetId,
} from '@mangostudio/shared/external-agents';
import { ExternalAccountLimitsSchema } from '@mangostudio/shared/external-agents';
import { Value } from '@sinclair/typebox/value';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';

export interface ExternalAccountLimitsCacheKey {
  readonly userId: string;
  readonly environmentId: string;
  readonly targetId: ExternalAgentTargetId;
  readonly vendorAccountFingerprint: string | null;
}

function fingerprintKey(fingerprint: string | null): string {
  return fingerprint ?? '';
}

export async function readExternalAccountLimitsCache(
  key: ExternalAccountLimitsCacheKey,
  db: Kysely<Database>
): Promise<ExternalAccountLimits | undefined> {
  const row = await db
    .selectFrom('external_account_limits_cache')
    .select(['limitsJson', 'observedAtMs'])
    .where('userId', '=', key.userId)
    .where('environmentId', '=', key.environmentId)
    .where('targetId', '=', key.targetId)
    .where('vendorAccountFingerprint', '=', fingerprintKey(key.vendorAccountFingerprint))
    .executeTakeFirst();
  if (!row) return undefined;
  try {
    const parsed: unknown = JSON.parse(row.limitsJson);
    if (!Value.Check(ExternalAccountLimitsSchema, parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function writeExternalAccountLimitsCache(
  key: ExternalAccountLimitsCacheKey,
  limits: ExternalAccountLimits,
  db: Kysely<Database>,
  nowMs: number = Date.now()
): Promise<void> {
  const fingerprint = fingerprintKey(key.vendorAccountFingerprint);
  const limitsJson = JSON.stringify(limits);
  await db
    .insertInto('external_account_limits_cache')
    .values({
      userId: key.userId,
      environmentId: key.environmentId,
      targetId: key.targetId,
      vendorAccountFingerprint: fingerprint,
      limitsJson,
      observedAtMs: limits.observedAtMs,
      updatedAt: nowMs,
    })
    .onConflict((oc) =>
      oc.columns(['userId', 'environmentId', 'targetId', 'vendorAccountFingerprint']).doUpdateSet({
        limitsJson,
        observedAtMs: limits.observedAtMs,
        updatedAt: nowMs,
      })
    )
    .execute();
}
