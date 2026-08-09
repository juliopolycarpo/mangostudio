/**
 * The selector's view of one environment's external agents.
 *
 * Wraps the query with the realtime invalidation the environments feature
 * already publishes, and answers the two questions every consumer asks: which
 * descriptor is this chat's runner, and may it start a turn right now.
 */

import type {
  ExternalAgentDescriptor,
  ExternalAgentTargetId,
} from '@mangostudio/shared/external-agents';
import { ENVIRONMENTS_TOPIC } from '@mangostudio/shared/realtime';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { externalAgentKeys, externalAgentsQueryOptions } from './queries';

export interface ExternalAgentsView {
  readonly agents: readonly ExternalAgentDescriptor[];
  readonly isLoading: boolean;
  readonly find: (targetId: ExternalAgentTargetId) => ExternalAgentDescriptor | undefined;
}

export function useExternalAgents(environmentId: string | null): ExternalAgentsView {
  const queryClient = useQueryClient();
  // A runtime connecting or dropping, an environment edited or removed: exactly
  // when "is Codex installed and signed in over there" stops being true.
  useRealtimeInvalidation(ENVIRONMENTS_TOPIC, async () => {
    await queryClient.invalidateQueries({ queryKey: externalAgentKeys.all });
  });

  const { data, isLoading } = useQuery(externalAgentsQueryOptions(environmentId));
  const agents = useMemo(() => data?.agents ?? [], [data?.agents]);

  return useMemo(
    () => ({
      agents,
      isLoading,
      find: (targetId) => agents.find((agent) => agent.targetId === targetId),
    }),
    [agents, isLoading]
  );
}

/**
 * Whether a descriptor can be picked, and why not when it cannot.
 *
 * `unknown` auth stays selectable on purpose: Claude may keep its credentials in
 * an OS keychain, so a missing credential file is not a signed-out verdict, and
 * disabling on it would make an installed, signed-in agent unusable. `signed-out`
 * is a verdict, and is not selectable.
 */
export function externalAgentSelectable(descriptor: ExternalAgentDescriptor): boolean {
  if (descriptor.unavailableReason) return false;
  if (!descriptor.installed) return false;
  return descriptor.authState !== 'signed-out';
}
