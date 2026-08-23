/**
 * External agents, scoped to the environment the chat runs in.
 *
 * The selector does not poll. Two user-scoped realtime signals keep it honest:
 * the environments topic, for a runtime connecting or dropping and an
 * environment added, edited or removed; and the external-agents topic, for the
 * hub's own background discovery probe finishing with a better answer than the
 * one it served. The first says the machine changed, the second says only that
 * what we know about it did.
 *
 * Keyed by environment, because a descriptor is only true of one machine: Codex
 * being signed in on the laptop says nothing about the build server.
 */

import type {
  ExternalAccountLimits,
  ExternalAgentDescriptor,
  ExternalAgentDescriptorListResponse,
} from '@mangostudio/shared/external-agents';
import type { QueryClient } from '@tanstack/react-query';
import { queryOptions } from '@tanstack/react-query';
import { getExternalAccountLimits, listExternalAgents } from '@/services/external-agent-service';

export const externalAgentKeys = {
  all: ['external-agents'] as const,
  byEnvironment: (environmentId: string) => ['external-agents', environmentId] as const,
};

export function externalAgentsQueryOptions(environmentId: string | null) {
  return queryOptions({
    queryKey: externalAgentKeys.byEnvironment(environmentId ?? ''),
    queryFn: () => listExternalAgents(environmentId ?? ''),
    enabled: environmentId !== null && environmentId.length > 0,
    // Discovery costs a bounded subprocess on someone else's machine. The
    // invalidation signal is what keeps this fresh; the window only stops a
    // burst of renders from each paying for it.
    staleTime: 30_000,
  });
}

/**
 * The account a quota snapshot belongs to.
 *
 * Vendor, machine and signed-in account: change any one of them and the snapshot
 * describes somebody else's allowance. Making that triple the cache key is what
 * lets two consumers share one entry without either of them being able to paint
 * a value fetched for another account — the key simply stops matching.
 */
export function externalAccountLimitsKey(descriptor: ExternalAgentDescriptor | null) {
  return [
    'external-account-limits',
    descriptor?.targetId ?? '',
    descriptor?.environmentId ?? '',
    descriptor?.account?.fingerprint ?? '',
  ] as const;
}

/**
 * The cold read of one account's quota. `null` is the machine's own answer —
 * "no snapshot" — and is cached as such; `undefined` only ever means loading.
 *
 * Never stales on its own. Quota costs a probe on someone else's machine, so the
 * only thing that re-reads it is the user asking, which is a separate POST.
 */
export function externalAccountLimitsQueryOptions(descriptor: ExternalAgentDescriptor | null) {
  const targetId = descriptor?.targetId;
  const environmentId = descriptor?.environmentId;
  const fingerprint = descriptor?.account?.fingerprint;
  return queryOptions({
    queryKey: externalAccountLimitsKey(descriptor),
    queryFn: async (): Promise<ExternalAccountLimits | null> => {
      if (!targetId || !environmentId) return null;
      const response = await getExternalAccountLimits(targetId, {
        environmentId,
        ...(fingerprint ? { vendorAccountFingerprint: fingerprint } : {}),
      });
      return response.limits ?? null;
    },
    enabled: Boolean(targetId && environmentId),
    staleTime: Number.POSITIVE_INFINITY,
    // Opted out of the client-wide retry: one failed probe already cost a
    // subprocess on somebody else's machine, and a silent second one buys a
    // chip nobody is waiting on. The user's refresh is the retry.
    retry: false,
  });
}

/**
 * Files a quota snapshot the hub sent down a turn's stream.
 *
 * The cold read never stales and nothing polls, so without this a header that
 * mounted before the turn keeps whatever it read then — "no snapshot", or last
 * week's percentage — while the vendor has already told us the current number
 * mid-turn. The user's manual refresh was the only way to see it.
 *
 * The account is resolved through the same cached descriptor list the pill and
 * the chip read (`useExternalAgents(environmentId).find(targetId)`), so the
 * write and the reads land on one key by construction and cannot disagree about
 * which account this is. No descriptor means nothing is rendering this target's
 * quota, and the snapshot is dropped rather than guessed at — writing under a
 * wildcard fingerprint is exactly the cross-account paint the key prevents.
 */
export function publishExternalAccountLimits(
  queryClient: QueryClient,
  environmentId: string | null,
  limits: ExternalAccountLimits
): void {
  if (!environmentId) return;
  const listed = queryClient.getQueryData<ExternalAgentDescriptorListResponse>(
    externalAgentKeys.byEnvironment(environmentId)
  );
  const descriptor = listed?.agents.find((agent) => agent.targetId === limits.targetId);
  if (!descriptor) return;

  const key = externalAccountLimitsKey(descriptor);
  const cached = queryClient.getQueryData<ExternalAccountLimits | null>(key);
  // A missing entry and a cached `null` are both older than any snapshot: the
  // "header mounted before the turn" case is the one worth fixing, and it is
  // exactly the one with nothing cached.
  if (cached && cached.observedAtMs >= limits.observedAtMs) return;
  queryClient.setQueryData(key, limits);
}
