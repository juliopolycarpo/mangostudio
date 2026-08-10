/**
 * External agents, scoped to the environment the chat runs in.
 *
 * The selector does not poll. Environment state changes already publish a
 * user-scoped invalidation on the environments realtime topic — a runtime
 * connecting or dropping, an environment added, edited or removed — and that is
 * exactly when these answers go stale, so the client refetches on a signal it is
 * already subscribed to.
 *
 * Keyed by environment, because a descriptor is only true of one machine: Codex
 * being signed in on the laptop says nothing about the build server.
 */

import { queryOptions } from '@tanstack/react-query';
import { listExternalAgents } from '@/services/external-agent-service';

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
