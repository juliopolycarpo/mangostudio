/**
 * Provider settings API mutation functions.
 */

import type { UpdateProviderRuntimeSettingsBody } from '@mangostudio/shared/provider-settings';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export async function updateProviderSettings(
  provider: string,
  body: UpdateProviderRuntimeSettingsBody
): Promise<void> {
  const { error } = await client.api.settings.providers({ provider }).put(body);
  if (error) throw new Error(extractApiError(error.value, 'Failed to save provider settings'));
}
