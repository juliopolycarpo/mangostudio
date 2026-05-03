/**
 * Tool settings API mutation functions.
 */

import type { UpdateToolSettingsBody } from '@mangostudio/shared/tool-settings';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export async function updateToolSetting(
  toolName: string,
  body: UpdateToolSettingsBody
): Promise<void> {
  const { error } = await client.api.settings.tools({ toolName }).put(body);
  if (error) throw new Error(extractApiError(error.value, 'Failed to save tool settings'));
}
