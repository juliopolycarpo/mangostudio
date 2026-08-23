/**
 * Cached account-quota snapshot for one external agent, with a manual refresh.
 *
 * Promoted out of the runner selector's chip so the header quota pill and the
 * chip read the same identity-guarded load: the cold cache read on mount, a
 * refresh only on request — never a poll — and a snapshot that can never be
 * painted onto another account after a switch.
 */

import type {
  ExternalAccountLimits,
  ExternalAgentDescriptor,
} from '@mangostudio/shared/external-agents';
import { useCallback, useEffect, useState } from 'react';
import {
  getExternalAccountLimits,
  refreshExternalAccountLimits,
} from '@/services/external-agent-service';

export interface ExternalAccountLimitsState {
  /** `undefined` while loading, `null` when the machine answered "no snapshot". */
  limits: ExternalAccountLimits | null | undefined;
  refreshing: boolean;
  refresh: () => void;
}

/**
 * The snapshot carries the identity it belongs to, so a stale value is
 * discarded when it is *read* rather than gated when it is written. Write-time
 * gating alone leaves `refreshing` latched on forever when the account changes
 * mid-request: the settling write is skipped, and the caller's refresh control
 * stays disabled for the account that never asked.
 */
interface IdentifiedLimits {
  identity: string | null;
  limits: ExternalAccountLimits | null | undefined;
  refreshing: boolean;
}

const EMPTY: IdentifiedLimits = { identity: null, limits: undefined, refreshing: false };

export function useExternalAccountLimits(
  descriptor: ExternalAgentDescriptor | null
): ExternalAccountLimitsState {
  const [snapshot, setSnapshot] = useState<IdentifiedLimits>(EMPTY);
  const identityKey = descriptor
    ? `${descriptor.targetId}:${descriptor.environmentId}:${descriptor.account?.fingerprint ?? ''}`
    : null;

  const targetId = descriptor?.targetId;
  const environmentId = descriptor?.environmentId;
  const fingerprint = descriptor?.account?.fingerprint;

  useEffect(() => {
    let cancelled = false;
    // Re-anchor the snapshot on the new identity: everything still in flight for
    // the old one is now unreadable, and nothing carries over from a previous
    // visit to this same identity.
    setSnapshot({ identity: identityKey, limits: undefined, refreshing: false });
    if (!targetId || !environmentId || !identityKey) return;
    void getExternalAccountLimits(targetId, {
      environmentId,
      ...(fingerprint ? { vendorAccountFingerprint: fingerprint } : {}),
    })
      .then((response) => {
        if (!cancelled) applyToIdentity(setSnapshot, identityKey, response.limits ?? null);
      })
      .catch(() => {
        if (!cancelled) applyToIdentity(setSnapshot, identityKey, null);
      });
    return () => {
      cancelled = true;
    };
  }, [targetId, environmentId, fingerprint, identityKey]);

  const refresh = useCallback(() => {
    if (!targetId || !environmentId || !identityKey) return;
    setSnapshot((prev) => (prev.identity === identityKey ? { ...prev, refreshing: true } : prev));
    void refreshExternalAccountLimits(targetId, {
      environmentId,
      ...(fingerprint ? { vendorAccountFingerprint: fingerprint } : {}),
    })
      .then((response) => {
        applyToIdentity(setSnapshot, identityKey, response.limits ?? null);
      })
      .catch(() => {
        // Keep the previous snapshot; the caller's chip stays as it was.
      })
      .finally(() => {
        setSnapshot((prev) =>
          prev.identity === identityKey ? { ...prev, refreshing: false } : prev
        );
      });
  }, [targetId, environmentId, fingerprint, identityKey]);

  // The effect re-anchors one commit late, so the first render after a switch
  // still holds the previous account's snapshot. Filter it here too.
  const current = snapshot.identity === identityKey;
  return {
    limits: current ? snapshot.limits : undefined,
    refreshing: current ? snapshot.refreshing : false,
    refresh,
  };
}

function applyToIdentity(
  setSnapshot: (updater: (prev: IdentifiedLimits) => IdentifiedLimits) => void,
  identity: string,
  limits: ExternalAccountLimits | null
): void {
  // Never touches `refreshing`: only the request that raised it may settle it.
  setSnapshot((prev) => (prev.identity === identity ? { ...prev, limits } : prev));
}
