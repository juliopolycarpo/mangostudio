import { DEFAULT_APP_SETTINGS, normalizeAppSettings } from '@mangostudio/shared/app-settings';
import { queryOptions } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

export const appSettingsKeys = {
  all: ['app-settings'] as const,
  current: () => [...appSettingsKeys.all, 'current'] as const,
  /** Mutation key: lets the layout observe auto-save state it does not own. */
  save: () => [...appSettingsKeys.all, 'save'] as const,
};

export function appSettingsQueryOptions() {
  return queryOptions({
    queryKey: appSettingsKeys.current(),
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await client.api.settings.app.get();
      if (error) throw new ApiError(error.value);
      return normalizeAppSettings(data ?? DEFAULT_APP_SETTINGS);
    },
  });
}
