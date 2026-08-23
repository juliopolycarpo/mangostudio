/**
 * Cached account-quota snapshot for one external agent, with a manual refresh.
 *
 * Promoted out of the runner selector's chip so the header quota pill and the
 * chip read the same identity-guarded load: the cold cache read on mount, a
 * refresh only on request — never a poll — and a snapshot that can never be
 * painted onto another account after a switch.
 *
 * Both of those consumers mount at once, so the state lives in the query cache
 * rather than in each caller's `useState`: one entry per account, one cold read
 * between them, and a refresh started from either one lands in the other.
 */

import type {
  ExternalAccountLimits,
  ExternalAgentDescriptor,
} from '@mangostudio/shared/external-agents';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { refreshExternalAccountLimits } from '@/services/external-agent-service';
import { externalAccountLimitsKey, externalAccountLimitsQueryOptions } from './queries';

export interface ExternalAccountLimitsState {
  /** `undefined` while loading, `null` when the machine answered "no snapshot". */
  limits: ExternalAccountLimits | null | undefined;
  refreshing: boolean;
  refresh: () => void;
}

export function useExternalAccountLimits(
  descriptor: ExternalAgentDescriptor | null
): ExternalAccountLimitsState {
  const queryClient = useQueryClient();
  const key = externalAccountLimitsKey(descriptor);
  const targetId = descriptor?.targetId;
  const environmentId = descriptor?.environmentId;
  const fingerprint = descriptor?.account?.fingerprint;

  // Re-annotated rather than inferred: the query result's `data` alias widens
  // the `null` arm back into the loading one, and the two mean different things
  // to every caller.
  const limits: ExternalAccountLimits | null | undefined = useQuery(
    externalAccountLimitsQueryOptions(descriptor)
  ).data;

  const { mutate } = useMutation({
    mutationKey: key,
    mutationFn: async (): Promise<ExternalAccountLimits | undefined> => {
      if (!targetId || !environmentId) return undefined;
      const response = await refreshExternalAccountLimits(targetId, {
        environmentId,
        ...(fingerprint ? { vendorAccountFingerprint: fingerprint } : {}),
      });
      return response.limits;
    },
    onSuccess: (refreshed) => {
      // A probe the hub could not complete comes back as HTTP 200 with no
      // `limits` — a non-answer, not a verdict. Writing it through would replace
      // a good snapshot with "no snapshot" and make the pill vanish because a
      // refresh failed. The cold read is where `null` legitimately means the
      // account has none; a refresh may only ever improve on what is cached.
      if (refreshed) queryClient.setQueryData(key, refreshed);
    },
  });

  // Read off the cache rather than off this hook's own mutation state, so a
  // refresh started from the header pill also locks the selector's chip — and so
  // switching accounts mid-request releases the lock instead of inheriting it.
  const refreshing = useIsMutating({ mutationKey: key, exact: true }) > 0;

  const refresh = useCallback(() => {
    if (!targetId || !environmentId) return;
    mutate();
  }, [mutate, targetId, environmentId]);

  return { limits, refreshing, refresh };
}
