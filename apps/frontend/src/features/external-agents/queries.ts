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
} from '@mangostudio/shared/external-agents';
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
  });
}
