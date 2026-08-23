/**
 * Regression coverage for settings mutations that feed the server-side chat
 * capability projection. Each successful mutation must make cached
 * projections stale immediately.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_LIBRARY_LOCATION_SETTINGS,
  withLibraryLocations,
} from '@mangostudio/shared/app-settings';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { chatCapabilitiesQueryOptions } from '../../../../src/features/chat/hooks/use-chat-capabilities';
import { appSettingsKeys } from '../../../../src/features/settings/app/queries';
import { useUpdateProviderSettings } from '../../../../src/features/settings/providers/hooks/use-provider-settings';
import { providerSettingsKeys } from '../../../../src/features/settings/providers/queries';
import {
  useToggleSkillSource,
  useUpdateSkillSetting,
} from '../../../../src/features/settings/skills/hooks/use-skill-settings';
import { skillSettingsKeys } from '../../../../src/features/settings/skills/queries';
import { useUpdateToolSetting } from '../../../../src/features/settings/tools/hooks/use-tool-settings';
import { toolSettingsKeys } from '../../../../src/features/settings/tools/queries';
import { useGlobalSettings } from '../../../../src/hooks/use-global-settings';
import { act, flushAsyncRender, renderHook, waitFor } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const CAPABILITIES_KEY: readonly unknown[] = chatCapabilitiesQueryOptions({
  chatId: 'chat-1',
}).queryKey;

function seedCapabilityProjection(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.setQueryData(CAPABILITIES_KEY, { runtimeHash: 'cached' });
  expect(queryClient.getQueryState(CAPABILITIES_KEY)?.isInvalidated).toBe(false);
}

/**
 * Lets the capability invalidation this mutation triggered land inside `act`.
 *
 * `registerCapabilityInvalidationSources` schedules the invalidation with
 * `queueMicrotask`, and React Query then announces the resulting cache change
 * through its own `setTimeout(callback, 0)`. Both fall outside the `act` around
 * `mutateAsync`, so under a loaded full-lane run the update landed after the
 * test body — four "update to TestComponent … not wrapped in act(...)" blocks
 * that never appear when this file runs alone.
 */
const drainCapabilityInvalidation = flushAsyncRender;

async function seedSourceThenProjection(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  data: unknown
) {
  queryClient.setQueryData(queryKey, data);
  await act(async () => {
    await Promise.resolve();
  });
  seedCapabilityProjection(queryClient);
}

describe('capability cache invalidation', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it('invalidates cached projections after a tool setting update', async () => {
    fetchScenario.respondWithJson('PUT', '/api/settings/tools/read_file', {
      body: {
        name: 'read_file',
        title: 'Read file',
        description: 'Reads a file.',
        category: 'system',
        enabled: false,
        canDisable: true,
        parameters: {},
        parameterDescriptors: [],
      },
    });

    const { result } = renderHook(() => ({
      mutation: useUpdateToolSetting(),
      queryClient: useQueryClient(),
    }));
    await seedSourceThenProjection(result.current.queryClient, toolSettingsKeys.list(), {
      tools: [],
    });

    await act(async () => {
      await result.current.mutation.mutateAsync({
        toolName: 'read_file',
        body: { enabled: false },
      });
    });
    await drainCapabilityInvalidation();

    expect(result.current.queryClient.getQueryState(CAPABILITIES_KEY)?.isInvalidated).toBe(true);
  });

  it('invalidates cached projections after a tool update with no cached tool list', async () => {
    fetchScenario.respondWithJson('PUT', '/api/settings/tools/read_file', {
      body: {
        name: 'read_file',
        title: 'Read file',
        description: 'Reads a file.',
        category: 'system',
        enabled: false,
        canDisable: true,
        parameters: {},
        parameterDescriptors: [],
      },
    });

    const { result } = renderHook(() => ({
      mutation: useUpdateToolSetting(),
      queryClient: useQueryClient(),
    }));
    // No tool-settings list in cache: syncToolSettingsListCache no-ops and the
    // registry observes nothing, so the mutation must invalidate directly.
    seedCapabilityProjection(result.current.queryClient);

    await act(async () => {
      await result.current.mutation.mutateAsync({
        toolName: 'read_file',
        body: { enabled: false },
      });
    });
    await drainCapabilityInvalidation();

    expect(result.current.queryClient.getQueryState(CAPABILITIES_KEY)?.isInvalidated).toBe(true);
  });

  it('invalidates cached projections after a skill setting update', async () => {
    fetchScenario.respondWithJson('PUT', '/api/skills/mango%3Areview', {
      body: {
        key: 'mango:review',
        slug: 'review',
        name: 'review',
        description: 'Reviews changes.',
        source: 'mango',
        path: '/skills/review',
        valid: true,
        enabled: false,
        shadowed: false,
      },
    });
    fetchScenario.respondWithJson('PUT', '/api/skills/mango:review', {
      body: {
        key: 'mango:review',
        slug: 'review',
        name: 'review',
        description: 'Reviews changes.',
        source: 'mango',
        path: '/skills/review',
        valid: true,
        enabled: false,
        shadowed: false,
      },
    });

    const { result } = renderHook(() => ({
      mutation: useUpdateSkillSetting(),
      queryClient: useQueryClient(),
    }));
    await seedSourceThenProjection(result.current.queryClient, skillSettingsKeys.list(), {
      skills: [],
    });

    await act(async () => {
      await result.current.mutation.mutateAsync({ skillKey: 'mango:review', enabled: false });
    });
    await drainCapabilityInvalidation();

    expect(result.current.queryClient.getQueryState(CAPABILITIES_KEY)?.isInvalidated).toBe(true);
  });

  it('invalidates cached projections after a skill source update', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/app', { body: DEFAULT_APP_SETTINGS });
    fetchScenario.respondWithJson('PUT', '/api/settings/app', {
      body: withLibraryLocations(DEFAULT_APP_SETTINGS, DEFAULT_PROFILE_ID, {
        ...DEFAULT_LIBRARY_LOCATION_SETTINGS,
        home: { ...DEFAULT_LIBRARY_LOCATION_SETTINGS.home, 'agents-skills': true },
      }),
    });

    const { result } = renderHook(() => ({
      mutation: useToggleSkillSource(),
      queryClient: useQueryClient(),
    }));
    await seedSourceThenProjection(
      result.current.queryClient,
      appSettingsKeys.current(),
      DEFAULT_APP_SETTINGS
    );

    await act(async () => {
      await result.current.mutation.mutateAsync({ source: 'agents', enabled: true });
    });
    await drainCapabilityInvalidation();

    expect(result.current.queryClient.getQueryState(CAPABILITIES_KEY)?.isInvalidated).toBe(true);
  });

  it('invalidates cached projections after provider runtime settings change', async () => {
    fetchScenario.respondWithJson('PUT', '/api/settings/providers/deepseek', {
      body: {
        provider: 'deepseek',
        displayName: 'DeepSeek',
        scope: 'provider',
        reasoning: {
          supportedEfforts: ['high', 'max'],
          defaultEffort: 'high',
          thinkingToggleSupported: true,
          reasoningWithToolsSupported: true,
        },
        promptCachingSupported: false,
        toolUseSupported: true,
        structuredOutputSupported: false,
        maxOutputTokensLimit: 64_000,
        settings: {
          provider: 'deepseek',
          thinkingEnabled: false,
          reasoningEffort: 'high',
          maxToolIterations: 15,
        },
        runtimeAvailable: true,
      },
    });

    const { result } = renderHook(() => ({
      mutation: useUpdateProviderSettings('deepseek'),
      queryClient: useQueryClient(),
    }));
    await seedSourceThenProjection(
      result.current.queryClient,
      providerSettingsKeys.detail('deepseek'),
      {}
    );

    await act(async () => {
      await result.current.mutation.mutateAsync({ thinkingEnabled: false });
    });
    await drainCapabilityInvalidation();

    expect(result.current.queryClient.getQueryState(CAPABILITIES_KEY)?.isInvalidated).toBe(true);
  });

  it('invalidates cached projections after multi-agent settings change', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/app', { body: DEFAULT_APP_SETTINGS });
    fetchScenario.respondWithJson('PUT', '/api/settings/app', {
      body: {
        ...DEFAULT_APP_SETTINGS,
        multiAgentSettings: { ...DEFAULT_APP_SETTINGS.multiAgentSettings, enabled: false },
      },
    });

    const { result } = renderHook(() => ({
      settings: useGlobalSettings(),
      queryClient: useQueryClient(),
    }));
    await waitFor(() => expect(result.current.settings.isLoading).toBe(false));
    await seedSourceThenProjection(
      result.current.queryClient,
      appSettingsKeys.current(),
      DEFAULT_APP_SETTINGS
    );

    act(() => {
      result.current.settings.setMultiAgentEnabled(false);
    });

    await waitFor(() =>
      expect(result.current.queryClient.getQueryState(CAPABILITIES_KEY)?.isInvalidated).toBe(true)
    );
  });

  it('invalidates projections when a future mutation only invalidates its source region', async () => {
    const { result } = renderHook(() => {
      const queryClient = useQueryClient();
      const mutation = useMutation({
        mutationFn: () => Promise.resolve(),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: toolSettingsKeys.all }),
      });
      return { mutation, queryClient };
    });
    await seedSourceThenProjection(result.current.queryClient, toolSettingsKeys.list(), {
      tools: [],
    });

    await act(async () => {
      await result.current.mutation.mutateAsync();
    });
    await drainCapabilityInvalidation();

    expect(result.current.queryClient.getQueryState(CAPABILITIES_KEY)?.isInvalidated).toBe(true);
  });
});
