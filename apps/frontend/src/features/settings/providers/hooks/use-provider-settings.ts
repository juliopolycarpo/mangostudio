/**
 * Hook: provider settings list and detail queries.
 */

import type {
  ProviderSettingsDescriptor,
  UpdateProviderRuntimeSettingsBody,
} from '@mangostudio/shared/provider-settings';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invalidateChatCapabilities } from '@/features/chat/hooks/use-chat-capabilities';
import { updateProviderSettings } from '../api';
import {
  providerSettingsDetailQueryOptions,
  providerSettingsKeys,
  providerSettingsListQueryOptions,
} from '../queries';

function syncProviderSettingsCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  descriptor: ProviderSettingsDescriptor
) {
  queryClient.setQueryData(providerSettingsKeys.detail(descriptor.provider), descriptor);
  queryClient.setQueryData(
    providerSettingsKeys.list(),
    (current: { providers: ProviderSettingsDescriptor[] } | undefined) => {
      if (!current) return current;

      return {
        providers: current.providers.map((provider) =>
          provider.provider === descriptor.provider ? descriptor : provider
        ),
      };
    }
  );
}

export function useProviderSettingsList() {
  const { data, isLoading, error, refetch } = useQuery(providerSettingsListQueryOptions());
  return { providers: data?.providers ?? [], isLoading, error, refetch };
}

export function useProviderSettings(provider: string | null) {
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    ...providerSettingsDetailQueryOptions(provider ?? ''),
    enabled: !!provider,
  });

  const invalidate = async () => {
    if (provider) {
      await queryClient.invalidateQueries({ queryKey: providerSettingsKeys.detail(provider) });
      await queryClient.invalidateQueries({ queryKey: providerSettingsKeys.list() });
    }
  };

  return { descriptor: data ?? null, isLoading, error, refetch, invalidate };
}

export function useUpdateProviderSettings(provider: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: UpdateProviderRuntimeSettingsBody) => updateProviderSettings(provider, body),
    onSuccess: (descriptor) => {
      syncProviderSettingsCaches(queryClient, descriptor);
      return invalidateChatCapabilities(queryClient);
    },
  });
}
