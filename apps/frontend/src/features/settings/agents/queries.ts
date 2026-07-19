import type { AgentProfileListResponse } from '@mangostudio/shared/agents';
import { queryOptions } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export const agentSettingsKeys = {
  all: ['agent-settings'] as const,
  list: () => [...agentSettingsKeys.all, 'list'] as const,
};

export function agentSettingsListQueryOptions() {
  return queryOptions({
    queryKey: agentSettingsKeys.list(),
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await client.api.settings.agents.get();
      if (error) throw new Error(extractApiError(error.value));
      return data as AgentProfileListResponse;
    },
  });
}
