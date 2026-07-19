import type { AppSettings } from '@mangostudio/shared/app-settings';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export async function updateAppSettings(settings: AppSettings): Promise<AppSettings> {
  const { data, error } = await client.api.settings.app.put(settings);
  if (error) throw new Error(extractApiError(error.value));
  return data as AppSettings;
}
