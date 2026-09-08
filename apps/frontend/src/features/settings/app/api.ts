import type { AppSettings, AppSettingsPutBody } from '@mangostudio/shared/app-settings';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

/**
 * Send a settings patch and get the whole normalized object back.
 *
 * Takes a patch, not a snapshot: the endpoint merges what it receives over
 * what it stores, so each caller sends the fields it actually edits and two
 * surfaces writing different settings stop overwriting one another.
 *
 * @example
 * await updateAppSettings({ thinkingEnabled: false });
 */
export async function updateAppSettings(patch: AppSettingsPutBody): Promise<AppSettings> {
  const { data, error } = await client.api.settings.app.put(patch);
  if (error) throw new ApiError(error.value);
  return data as AppSettings;
}
