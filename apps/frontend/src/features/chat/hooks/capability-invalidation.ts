/**
 * Chat capability projections mirror inputs read by the server-side resolver.
 * Registering a source cache region here covers every source change the query
 * cache actually reports. Successful source refetches also mark projections
 * stale, favoring correctness over avoiding an inexpensive refetch.
 *
 * Blind spot: the registry only sees changes the cache emits an event for. A
 * `setQueryData` whose updater returns `undefined`, and an `invalidateQueries`
 * against a region holding no cached query, both dispatch nothing. Mutations
 * that write their source through such an updater must therefore still call
 * `invalidateChatCapabilities` directly — see `useUpdateToolSetting`.
 */

import {
  partialMatchKey,
  type QueryCacheNotifyEvent,
  type QueryClient,
} from '@tanstack/react-query';
import { agentSettingsKeys } from '@/features/settings/agents/queries';
import { appSettingsKeys } from '@/features/settings/app/queries';
import { mcpServerKeys } from '@/features/settings/mcp/queries';
import { providerSettingsKeys } from '@/features/settings/providers/queries';
import { skillSettingsKeys } from '@/features/settings/skills/queries';
import { toolSettingsKeys } from '@/features/settings/tools/queries';
import { catalogKeys } from '@/hooks/use-model-catalog';
import { chatCapabilitiesKeys } from './use-chat-capabilities';

const CAPABILITY_SOURCE_KEYS: readonly (readonly unknown[])[] = [
  toolSettingsKeys.all,
  skillSettingsKeys.all,
  providerSettingsKeys.all,
  appSettingsKeys.all,
  agentSettingsKeys.all,
  mcpServerKeys.all,
  catalogKeys.all,
];

/** Root segments of every source region, for a constant-time reject. */
const CAPABILITY_SOURCE_ROOTS = new Set(CAPABILITY_SOURCE_KEYS.map((key) => key[0]));

function isCapabilitySourceUpdate(event: QueryCacheNotifyEvent): boolean {
  if (event.type !== 'updated') return false;
  if (event.action.type !== 'invalidate' && event.action.type !== 'success') return false;
  // Rejects unrelated keys without a deep compare; this runs on every cache event.
  if (!CAPABILITY_SOURCE_ROOTS.has(event.query.queryKey[0])) return false;

  return CAPABILITY_SOURCE_KEYS.some((sourceKey) =>
    partialMatchKey(event.query.queryKey, sourceKey)
  );
}

/** Marks every cached capability projection stale. */
export function invalidateChatCapabilities(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: chatCapabilitiesKeys.all });
}

/** Subscribes one QueryClient to all cache regions that feed capability resolution. */
export function registerCapabilityInvalidationSources(queryClient: QueryClient): () => void {
  let active = true;
  let invalidationScheduled = false;

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (!isCapabilitySourceUpdate(event) || invalidationScheduled) return;

    invalidationScheduled = true;
    queueMicrotask(() => {
      invalidationScheduled = false;
      if (!active) return;

      // Capability keys are not source keys, so this cannot re-enter the registry.
      void invalidateChatCapabilities(queryClient);
    });
  });

  return () => {
    active = false;
    unsubscribe();
  };
}
