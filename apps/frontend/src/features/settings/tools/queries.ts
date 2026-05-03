/**
 * Tool settings query keys and options.
 */

import { queryOptions } from '@tanstack/react-query';
import type { ToolSettingsListResponse } from '@mangostudio/shared/tool-settings';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export const toolSettingsKeys = {
  all: ['tool-settings'] as const,
  list: () => [...toolSettingsKeys.all, 'list'] as const,
};

export function toolSettingsListQueryOptions() {
  return queryOptions({
    queryKey: toolSettingsKeys.list(),
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await client.api.settings.tools.get();
      if (error) throw new Error(extractApiError(error.value, 'Failed to load tools'));
      return data as ToolSettingsListResponse;
    },
  });
}
