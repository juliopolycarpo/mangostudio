/**
 * Hub-side account-quota refresh and cache read.
 *
 * No-live-session policy: open a short-lived runtime probe via
 * `external-agent.refresh-account-usage` rather than reporting unknown. The
 * selector refresh button has to work before any turn starts — that is when
 * the user most needs to see remaining quota. When the caller already has a
 * live hub session id, that session is preferred so the baseline stays shared.
 */

import type {
  ExternalAccountLimits,
  ExternalAgentTargetId,
} from '@mangostudio/shared/external-agents';
import { getDb } from '../../../db/database';
import { createDiagnosticLogger } from '../../../lib/logger';
import { getRuntimeClient } from '../../../services/runtime-client';
import {
  type ExternalAccountLimitsCacheKey,
  readExternalAccountLimitsCache,
  writeExternalAccountLimitsCache,
} from '../infrastructure/external-account-limits-cache';

const logger = createDiagnosticLogger('external-account-limits');

/** Bound for a manual refresh: cold app-server start on a remote machine. */
const REFRESH_TIMEOUT_MS = 30_000;

export interface ReadCachedAccountLimitsInput {
  readonly userId: string;
  readonly environmentId: string;
  readonly targetId: ExternalAgentTargetId;
  readonly vendorAccountFingerprint: string | null;
}

export async function readCachedExternalAccountLimits(
  input: ReadCachedAccountLimitsInput
): Promise<ExternalAccountLimits | undefined> {
  return await readExternalAccountLimitsCache(input, getDb());
}

export interface RefreshExternalAccountLimitsInput {
  readonly userId: string;
  readonly environmentId: string;
  readonly targetId: ExternalAgentTargetId;
  readonly vendorAccountFingerprint: string | null;
  /** Optional live hub session to refresh against instead of a short-lived probe. */
  readonly sessionId?: string;
}

export async function refreshExternalAccountLimits(
  input: RefreshExternalAccountLimitsInput
): Promise<ExternalAccountLimits | undefined> {
  const runtime = await getRuntimeClient(input.userId, input.environmentId);

  try {
    const result = await runtime.externalAgents.refreshAccountUsage(
      {
        targetId: input.targetId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        timeoutMs: REFRESH_TIMEOUT_MS,
      },
      { timeoutMs: REFRESH_TIMEOUT_MS + 5_000 }
    );
    if (!result.limits) return undefined;
    const key: ExternalAccountLimitsCacheKey = {
      userId: input.userId,
      environmentId: input.environmentId,
      targetId: input.targetId,
      vendorAccountFingerprint: input.vendorAccountFingerprint,
    };
    await writeExternalAccountLimitsCache(key, result.limits, getDb());
    return result.limits;
  } catch (error) {
    logger.warn('Account-limits refresh failed', {
      targetId: input.targetId,
      environmentId: input.environmentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Persist a snapshot observed on a live turn stream. */
export async function cacheExternalAccountLimits(
  key: ExternalAccountLimitsCacheKey,
  limits: ExternalAccountLimits
): Promise<void> {
  await writeExternalAccountLimitsCache(key, limits, getDb());
}
