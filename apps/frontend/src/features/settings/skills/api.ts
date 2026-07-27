/**
 * Skill settings API mutation functions.
 */

import type { SkillDescriptor, UpdateSkillSettingsBody } from '@mangostudio/shared/skills';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

export async function updateSkillSetting(
  skillKey: string,
  body: UpdateSkillSettingsBody
): Promise<SkillDescriptor> {
  const { data, error } = await client.api.skills({ skillKey }).put(body);
  if (error) throw new ApiError(error.value);
  return data as SkillDescriptor;
}

export async function rescanLibrary(): Promise<void> {
  const { error } = await client.api.library.rescan.post(undefined, {
    query: { force: 'true' },
  });
  if (error) throw new ApiError(error.value);
}
