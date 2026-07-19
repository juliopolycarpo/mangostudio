/**
 * Provider settings query keys and options.
 */

import type {
  ProviderSettingsDescriptor,
  ProviderSettingsListResponse,
} from '@mangostudio/shared/provider-settings';
import { queryOptions } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export const providerSettingsKeys = {
  all: ['provider-settings'] as const,
  list: () => [...providerSettingsKeys.all, 'list'] as const,
  detail: (provider: string) => [...providerSettingsKeys.all, 'detail', provider] as const,
};

export function providerSettingsListQueryOptions() {
  return queryOptions({
    queryKey: providerSettingsKeys.list(),
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await client.api.settings.providers.get();
      if (error) throw new Error(extractApiError(error.value));
      return data as ProviderSettingsListResponse;
    },
  });
}

export function providerSettingsDetailQueryOptions(provider: string) {
  return queryOptions({
    queryKey: providerSettingsKeys.detail(provider),
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await client.api.settings.providers({ provider }).get();
      if (error) throw new Error(extractApiError(error.value));
      return data as ProviderSettingsDescriptor;
    },
  });
}
