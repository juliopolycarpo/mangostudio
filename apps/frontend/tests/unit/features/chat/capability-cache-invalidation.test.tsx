/**
 * Regression coverage for settings mutations that feed the server-side chat
 * capability projection. Each successful mutation must make cached
 * projections stale immediately.
 */

import { DEFAULT_APP_SETTINGS } from '@mangostudio/shared/app-settings';
import { useQueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatCapabilitiesQueryOptions } from '../../../../src/features/chat/hooks/use-chat-capabilities';
import { useUpdateProviderSettings } from '../../../../src/features/settings/providers/hooks/use-provider-settings';
import {
  useToggleSkillSource,
  useUpdateSkillSetting,
} from '../../../../src/features/settings/skills/hooks/use-skill-settings';
import { useUpdateToolSetting } from '../../../../src/features/settings/tools/hooks/use-tool-settings';
import { useGlobalSettings } from '../../../../src/hooks/use-global-settings';
import { act, renderHook, waitFor } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const CAPABILITIES_KEY: readonly unknown[] = chatCapabilitiesQueryOptions({
  chatId: 'chat-1',
}).queryKey;

function seedCapabilityProjection(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.setQueryData(CAPABILITIES_KEY, { runtimeHash: 'cached' });
  expect(queryClient.getQueryState(CAPABILITIES_KEY)?.isInvalidated).toBe(false);
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
    seedCapabilityProjection(result.current.queryClient);

    await act(async () => {
      await result.current.mutation.mutateAsync({
        toolName: 'read_file',
        body: { enabled: false },
      });
    });

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
    seedCapabilityProjection(result.current.queryClient);

    await act(async () => {
      await result.current.mutation.mutateAsync({ skillKey: 'mango:review', enabled: false });
    });

    expect(result.current.queryClient.getQueryState(CAPABILITIES_KEY)?.isInvalidated).toBe(true);
  });

  it('invalidates cached projections after a skill source update', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/app', { body: DEFAULT_APP_SETTINGS });
    fetchScenario.respondWithJson('PUT', '/api/settings/app', {
      body: {
        ...DEFAULT_APP_SETTINGS,
        skillSources: { ...DEFAULT_APP_SETTINGS.skillSources, agents: true },
      },
    });

    const { result } = renderHook(() => ({
      mutation: useToggleSkillSource(),
      queryClient: useQueryClient(),
    }));
    seedCapabilityProjection(result.current.queryClient);

    await act(async () => {
      await result.current.mutation.mutateAsync({ source: 'agents', enabled: true });
    });

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
    seedCapabilityProjection(result.current.queryClient);

    await act(async () => {
      await result.current.mutation.mutateAsync({ thinkingEnabled: false });
    });

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
    seedCapabilityProjection(result.current.queryClient);

    act(() => {
      result.current.settings.setMultiAgentEnabled(false);
    });

    await waitFor(() =>
      expect(result.current.queryClient.getQueryState(CAPABILITIES_KEY)?.isInvalidated).toBe(true)
    );
  });
});
