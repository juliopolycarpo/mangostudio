import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  SkillDescriptor,
  SkillListResponse,
  UpdateSkillSettingsBody,
} from '@mangostudio/shared/skills';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { parseSkillKey, SkillError } from '../domain/skill';
import { upsertSkillSettings } from '../infrastructure/skill-settings-repository';
import { listSkills } from './skill-discovery';

export class SkillSettingsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = 'SkillSettingsError';
  }
}

/** Lists every discovered skill with enabled/shadowed resolved, plus source state. */
// biome-ignore lint/suspicious/useAwait: delegates to async listSkills without extra work
export async function listSkillSettings(
  db: Kysely<Database>,
  userId: string
): Promise<SkillListResponse> {
  return listSkills(db, userId);
}

/**
 * Persists a per-skill enable/disable override. Validates that the skill key
 * refers to a real discovered skill before writing.
 */
export async function updateSkillSettings(
  db: Kysely<Database>,
  userId: string,
  skillKey: string,
  body: UpdateSkillSettingsBody
): Promise<SkillDescriptor> {
  const parsed = parseSkillKey(skillKey);
  if (!parsed) {
    throw new SkillSettingsError(`Invalid skill key "${skillKey}".`, 422, ERROR_CODES.VALIDATION);
  }

  const { skills } = await listSkills(db, userId);
  const skill = skills.find((candidate) => candidate.key === skillKey);
  if (!skill) {
    throw new SkillSettingsError(`Unknown skill "${skillKey}".`, 404, ERROR_CODES.NOT_FOUND);
  }

  await upsertSkillSettings(db, userId, skillKey, body.enabled);
  return { ...skill, enabled: body.enabled };
}

export { SkillError };
