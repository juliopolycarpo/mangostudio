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
import { ENVIRONMENTS_TOPIC, EXTERNAL_AGENTS_TOPIC } from '@mangostudio/shared/realtime';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { externalAgentKeys, externalAgentsQueryOptions } from './queries';

export interface ExternalAgentsView {
  readonly agents: readonly ExternalAgentDescriptor[];
  readonly isLoading: boolean;
  readonly find: (targetId: ExternalAgentTargetId) => ExternalAgentDescriptor | undefined;
}

export function useExternalAgents(environmentId: string | null): ExternalAgentsView {
  const queryClient = useQueryClient();
  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: externalAgentKeys.all });
  }, [queryClient]);

  // A runtime connecting or dropping, an environment edited or removed: exactly
  // when "is Codex installed and signed in over there" stops being true.
  useRealtimeInvalidation(ENVIRONMENTS_TOPIC, invalidate);
  // The machine did not change, but the hub finished probing it. The first
  // render after a cold cache shows the capability-free scan — no model or
  // permission picker — and this is what fills them in once the vendor answers.
  useRealtimeInvalidation(EXTERNAL_AGENTS_TOPIC, invalidate);

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
  // `disclosure-required` is the one reason the user can clear from here, so it
  // must not disable the row: the notice is reached by picking the agent, and a
  // greyed-out row would leave the only way through it unreachable. Every other
  // reason needs an install, a login, or somebody else's change to a machine.
  if (descriptor.unavailableReason && descriptor.unavailableReason !== 'disclosure-required') {
    return false;
  }
  if (!descriptor.installed) return false;
  return descriptor.authState !== 'signed-out';
}
