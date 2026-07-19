/**
 * Skill settings API mutation functions.
 */

import type { SkillDescriptor, UpdateSkillSettingsBody } from '@mangostudio/shared/skills';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export async function updateSkillSetting(
  skillKey: string,
  body: UpdateSkillSettingsBody
): Promise<SkillDescriptor> {
  const { data, error } = await client.api.skills({ skillKey }).put(body);
  if (error) throw new Error(extractApiError(error.value));
  return data as SkillDescriptor;
}
