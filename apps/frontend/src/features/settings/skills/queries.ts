/**
 * Skill settings query keys and options.
 */

import { en } from '@mangostudio/shared/i18n';
import type { SkillListResponse } from '@mangostudio/shared/skills';
import { queryOptions } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export const skillSettingsKeys = {
  all: ['skill-settings'] as const,
  list: () => [...skillSettingsKeys.all, 'list'] as const,
};

export function skillSettingsListQueryOptions() {
  return queryOptions({
    queryKey: skillSettingsKeys.list(),
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await client.api.skills.get();
      if (error) throw new Error(extractApiError(error.value, en.settings.skills.loadError));
      return data as SkillListResponse;
    },
  });
}
