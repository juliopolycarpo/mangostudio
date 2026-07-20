import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { registerCapabilityInvalidationSources } from '../../../../src/features/chat/hooks/capability-invalidation';
import { chatCapabilitiesQueryOptions } from '../../../../src/features/chat/hooks/use-chat-capabilities';
import { chatKeys } from '../../../../src/features/chat/queries';
import { appSettingsKeys } from '../../../../src/features/settings/app/queries';
import { skillSettingsKeys } from '../../../../src/features/settings/skills/queries';
import { toolSettingsKeys } from '../../../../src/features/settings/tools/queries';

const CAPABILITIES_KEY: readonly unknown[] = chatCapabilitiesQueryOptions({
  chatId: 'chat-1',
}).queryKey;

async function flushScheduledInvalidation() {
  await Promise.resolve();
}

/** The registry's blind spot: cache writes that dispatch no event. */
describe('capability invalidation blind spots', () => {
  it('sees no event when a source updater returns undefined on an uncached key', async () => {
    const queryClient = new QueryClient();
    const unregister = registerCapabilityInvalidationSources(queryClient);
    queryClient.setQueryData(CAPABILITIES_KEY, { runtimeHash: 'cached' });

    // Mirrors syncToolSettingsListCache when the list was never fetched.
    queryClient.setQueryData(toolSettingsKeys.list(), (current: unknown) =>
      current ? { tools: [] } : current
    );
    await flushScheduledInvalidation();

    expect(queryClient.getQueryState(CAPABILITIES_KEY)?.isInvalidated).toBe(false);
    unregister();
  });

  it('sees no event when invalidating a region holding no cached query', async () => {
    const queryClient = new QueryClient();
    const unregister = registerCapabilityInvalidationSources(queryClient);
    queryClient.setQueryData(CAPABILITIES_KEY, { runtimeHash: 'cached' });

    await queryClient.invalidateQueries({ queryKey: toolSettingsKeys.all });
    await flushScheduledInvalidation();

    expect(queryClient.getQueryState(CAPABILITIES_KEY)?.isInvalidated).toBe(false);
    unregister();
  });
});

describe('capability invalidation registry', () => {
  it('invalidates capability projections after source data updates', async () => {
    const queryClient = new QueryClient();
    const unregister = registerCapabilityInvalidationSources(queryClient);
    queryClient.setQueryData(CAPABILITIES_KEY, { runtimeHash: 'cached' });

    queryClient.setQueryData(toolSettingsKeys.list(), { tools: [] });
    await flushScheduledInvalidation();

    expect(queryClient.getQueryState(CAPABILITIES_KEY)?.isInvalidated).toBe(true);
    unregister();
  });

  it('ignores updates outside capability source regions', async () => {
    const queryClient = new QueryClient();
    const unregister = registerCapabilityInvalidationSources(queryClient);
    queryClient.setQueryData(CAPABILITIES_KEY, { runtimeHash: 'cached' });

    queryClient.setQueryData(chatKeys.lists(), []);
    await flushScheduledInvalidation();

    expect(queryClient.getQueryState(CAPABILITIES_KEY)?.isInvalidated).toBe(false);
    unregister();
  });

  it('coalesces a burst of source updates into one capability invalidation', async () => {
    const queryClient = new QueryClient();
    const unregister = registerCapabilityInvalidationSources(queryClient);
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');

    queryClient.setQueryData(toolSettingsKeys.list(), { tools: [] });
    queryClient.setQueryData(skillSettingsKeys.list(), { skills: [] });
    queryClient.setQueryData(appSettingsKeys.current(), {});
    await flushScheduledInvalidation();

    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['chat-capabilities'],
    });
    unregister();
  });
});
