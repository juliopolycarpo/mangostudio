/**
 * Hook: provider settings list and detail queries.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  providerSettingsKeys,
  providerSettingsListQueryOptions,
  providerSettingsDetailQueryOptions,
} from '../queries';

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
