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
import { useCallback, useEffect, useRef, useState } from 'react';
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

export function useExternalAccountLimits(
  descriptor: ExternalAgentDescriptor | null
): ExternalAccountLimitsState {
  const [limits, setLimits] = useState<ExternalAccountLimits | null | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const identityKey = descriptor
    ? `${descriptor.targetId}:${descriptor.environmentId}:${descriptor.account?.fingerprint ?? ''}`
    : null;
  const identityRef = useRef(identityKey);
  identityRef.current = identityKey;

  const targetId = descriptor?.targetId;
  const environmentId = descriptor?.environmentId;
  const fingerprint = descriptor?.account?.fingerprint;

  useEffect(() => {
    let cancelled = false;
    // Drop the previous account's snapshot immediately so a late response cannot
    // paint one identity's quota onto another.
    setLimits(undefined);
    if (!targetId || !environmentId || !identityKey) return;
    void getExternalAccountLimits(targetId, {
      environmentId,
      ...(fingerprint ? { vendorAccountFingerprint: fingerprint } : {}),
    })
      .then((response) => {
        if (!cancelled && identityRef.current === identityKey) {
          setLimits(response.limits ?? null);
        }
      })
      .catch(() => {
        if (!cancelled && identityRef.current === identityKey) setLimits(null);
      });
    return () => {
      cancelled = true;
    };
  }, [targetId, environmentId, fingerprint, identityKey]);

  const refresh = useCallback(() => {
    if (!targetId || !environmentId) return;
    const requestIdentity = identityRef.current;
    setRefreshing(true);
    void refreshExternalAccountLimits(targetId, {
      environmentId,
      ...(fingerprint ? { vendorAccountFingerprint: fingerprint } : {}),
    })
      .then((response) => {
        if (identityRef.current === requestIdentity) {
          setLimits(response.limits ?? null);
        }
      })
      .catch(() => {
        // Keep the previous snapshot; the caller's chip stays as it was.
      })
      .finally(() => {
        if (identityRef.current === requestIdentity) setRefreshing(false);
      });
  }, [targetId, environmentId, fingerprint]);

  return { limits, refreshing, refresh };
}
