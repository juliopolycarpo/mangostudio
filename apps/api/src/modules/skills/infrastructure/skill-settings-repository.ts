import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { generateId } from '../../../utils/id';

/** Saved per-skill enabled flags keyed by `<source>:<slug>`; absent keys default to enabled. */
export async function listSavedSkillSettings(
  db: Kysely<Database>,
  userId: string
): Promise<Map<string, boolean>> {
  const rows = await db
    .selectFrom('user_skill_settings')
    .select(['skillKey', 'enabled'])
    .where('userId', '=', userId)
    .execute();

  return new Map(rows.map((row) => [row.skillKey, row.enabled !== 0]));
}

export async function upsertSkillSettings(
  db: Kysely<Database>,
  userId: string,
  skillKey: string,
  enabled: boolean
): Promise<void> {
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
}
