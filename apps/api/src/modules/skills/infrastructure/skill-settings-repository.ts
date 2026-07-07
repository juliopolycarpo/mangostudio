import type { Kysely } from 'kysely';
import type { Database, UserSkillSettingsSelect } from '../../../db/types';
import { generateId } from '../../../utils/id';

/** Per-skill enable/disable state for one user, keyed by `<source>:<slug>`. */
export interface SkillSettingsRow {
  skillKey: string;
  enabled: boolean;
}

/**
 * Lists the saved per-skill settings for a user. Skills without a row default
 * to enabled, so callers only need the persisted overrides.
 */
export async function listSavedSkillSettings(
  db: Kysely<Database>,
  userId: string
): Promise<Map<string, boolean>> {
  const rows: Pick<UserSkillSettingsSelect, 'skillKey' | 'enabled'>[] = await db
    .selectFrom('user_skill_settings')
    .select(['skillKey', 'enabled'])
    .where('userId', '=', userId)
    .execute();

  const settings = new Map<string, boolean>();
  for (const row of rows) {
    settings.set(row.skillKey, row.enabled !== 0);
  }
  return settings;
}

/** Persists a per-skill enable/disable override, keyed by `<source>:<slug>`. */
export async function upsertSkillSettings(
  db: Kysely<Database>,
  userId: string,
  skillKey: string,
  enabled: boolean
): Promise<boolean> {
  const now = Date.now();
  const enabledFlag = enabled ? 1 : 0;

  await db
    .insertInto('user_skill_settings')
    .values({
      id: generateId(),
      userId,
      skillKey,
      enabled: enabledFlag,
      createdAt: now,
      updatedAt: now,
    })
    .onConflict((oc) =>
      oc.columns(['userId', 'skillKey']).doUpdateSet({ enabled: enabledFlag, updatedAt: now })
    )
    .execute();

  return enabled;
}
