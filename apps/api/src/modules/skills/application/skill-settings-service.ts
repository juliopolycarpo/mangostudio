/**
 * Skill settings: the Settings → Skills listing (discovered skills plus
 * third-party source states) and per-skill enable/disable persistence.
 */

import { existsSync } from 'node:fs';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  SkillDescriptor,
  SkillListResponse,
  UpdateSkillSettingsBody,
} from '@mangostudio/shared/skills';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import { parseSkillKey, SkillError } from '../domain/skill';
import { upsertSkillSettings } from '../infrastructure/skill-settings-repository';
import { getThirdPartySkillDirs, listSkills } from './skill-discovery';

/** Builds the skills settings listing. // Usage: await listSkillSettings(db, userId) */
export async function listSkillSettings(
  db: Kysely<Database>,
  userId: string
): Promise<SkillListResponse> {
  const [skills, appSettings] = await Promise.all([
    listSkills(db, userId),
    getAppSettings(db, userId),
  ]);
  const thirdPartyDirs = getThirdPartySkillDirs();

  return {
    skills,
    sources: {
      agents: {
        enabled: appSettings.skillSources.agents,
        path: thirdPartyDirs.agents,
        exists: existsSync(thirdPartyDirs.agents),
      },
      claude: {
        enabled: appSettings.skillSources.claude,
        path: thirdPartyDirs.claude,
        exists: existsSync(thirdPartyDirs.claude),
      },
    },
  };
}

/**
 * Persists one skill's enabled flag and returns the updated descriptor.
 * // Usage: await updateSkillSetting(db, userId, 'mango:pdf-tools', { enabled: false })
 */
export async function updateSkillSetting(
  db: Kysely<Database>,
  userId: string,
  skillKey: string,
  body: UpdateSkillSettingsBody
): Promise<SkillDescriptor> {
  if (!parseSkillKey(skillKey)) {
    throw new SkillError(`Unknown skill "${skillKey}".`, 404, ERROR_CODES.NOT_FOUND);
  }

  const skills = await listSkills(db, userId);
  const skill = skills.find((candidate) => candidate.key === skillKey);
  if (!skill) {
    throw new SkillError(`Unknown skill "${skillKey}".`, 404, ERROR_CODES.NOT_FOUND);
  }

  await upsertSkillSettings(db, userId, skillKey, body.enabled);
  return { ...skill, enabled: body.enabled };
}
