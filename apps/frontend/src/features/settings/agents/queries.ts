import type { AgentProfileListResponse } from '@mangostudio/shared/agents';
import { queryOptions } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

export const agentSettingsKeys = {
  all: ['agent-settings'] as const,
  list: () => [...agentSettingsKeys.all, 'list'] as const,
};

export function agentSettingsListQueryOptions() {
  return queryOptions({
    queryKey: agentSettingsKeys.list(),
    staleTime: 30_000,
    // A shell bootstrap query: once refused, it is asked again by the bootstrap
    // panel's retry, not by whichever component mounts next — that would retry
    // a rate-limited request on every mount. See `features/bootstrap`.
    retryOnMount: false,
    queryFn: async () => {
      const { data, error } = await client.api.settings.agents.get();
      if (error) throw new ApiError(error.value);
      return data as AgentProfileListResponse;
    },
  });
}
