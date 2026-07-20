/**
 * Tool settings query keys and options.
 */

import type { ToolSettingsListResponse } from '@mangostudio/shared/tool-settings';
import { queryOptions } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

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
      if (error) throw new ApiError(error.value);
      return data as ToolSettingsListResponse;
    },
  });
}
