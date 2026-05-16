import type {
  ProviderObservabilityLogsResponse,
  ProviderObservabilityMetricsResponse,
} from '@mangostudio/shared/observability';
import { queryOptions } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export const observabilityKeys = {
  all: ['observability'] as const,
  metrics: () => [...observabilityKeys.all, 'metrics'] as const,
  logs: () => [...observabilityKeys.all, 'logs'] as const,
};

export function observabilityMetricsQueryOptions() {
  return queryOptions({
    queryKey: observabilityKeys.metrics(),
    staleTime: 5_000,
    refetchInterval: 5_000,
    queryFn: async () => {
      const { data, error } = await client.api.settings.metrics.get();
      if (error) throw new Error(extractApiError(error.value, 'Failed to load metrics'));
      return data as ProviderObservabilityMetricsResponse;
    },
  });
}

export function observabilityLogsQueryOptions() {
  return queryOptions({
    queryKey: observabilityKeys.logs(),
    staleTime: 5_000,
    refetchInterval: 5_000,
    queryFn: async () => {
      const { data, error } = await client.api.settings.logs.get();
      if (error) throw new Error(extractApiError(error.value, 'Failed to load logs'));
      return data as ProviderObservabilityLogsResponse;
    },
  });
}
