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
