/**
 * Tool settings API mutation functions.
 */

import { en } from '@mangostudio/shared/i18n';
import type {
  ToolSettingsDescriptor,
  UpdateToolSettingsBody,
} from '@mangostudio/shared/tool-settings';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export async function updateToolSetting(
  toolName: string,
  body: UpdateToolSettingsBody
): Promise<ToolSettingsDescriptor> {
  const { data, error } = await client.api.settings.tools({ toolName }).put(body);
  if (error) throw new Error(extractApiError(error.value, en.settings.tools.saveError));
  return data as ToolSettingsDescriptor;
}
