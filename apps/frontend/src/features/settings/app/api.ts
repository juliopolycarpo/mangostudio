import type { AppSettingsPutBody, AppSettingsResponse } from '@mangostudio/shared/app-settings';

import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

/**
 * Send a settings patch with its snapshot revision and return confirmed metadata.
 *
 * Takes a patch, not a snapshot: the endpoint merges what it receives over
 * what it stores, so each caller sends the fields it actually edits and two
 * surfaces writing different settings stop overwriting one another.
 *
 * @example
 * await updateAppSettings({ thinkingEnabled: false }, snapshot.revision);
 */
export async function updateAppSettings(
  patch: AppSettingsPutBody,
  revision?: string
): Promise<AppSettingsResponse> {
  const { data, error } = await client.api.settings.app.put(patch, {
    headers: revision === undefined ? {} : { 'if-match': revision },
  });
  if (error) throw new ApiError(error.value);
  return data as AppSettingsResponse;
}
