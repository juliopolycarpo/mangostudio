/**
 * Tool settings API mutation functions.
 */

import type {
  ToolSettingsDescriptor,
  UpdateToolSettingsBody,
} from '@mangostudio/shared/tool-settings';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

export async function updateToolSetting(
  toolName: string,
  body: UpdateToolSettingsBody
): Promise<ToolSettingsDescriptor> {
  const { data, error } = await client.api.settings.tools({ toolName }).put(body);
  if (error) throw new ApiError(error.value);
  return data as ToolSettingsDescriptor;
}
