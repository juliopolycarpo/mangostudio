import { queryOptions } from '@tanstack/react-query';
import { DEFAULT_APP_SETTINGS, normalizeAppSettings } from '@mangostudio/shared/app-settings';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export const appSettingsKeys = {
  all: ['app-settings'] as const,
  current: () => [...appSettingsKeys.all, 'current'] as const,
};

export function appSettingsQueryOptions() {
  return queryOptions({
    queryKey: appSettingsKeys.current(),
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await client.api.settings.app.get();
      if (error) throw new Error(extractApiError(error.value, 'Failed to load app settings'));
      return normalizeAppSettings(data ?? DEFAULT_APP_SETTINGS);
    },
  });
}
