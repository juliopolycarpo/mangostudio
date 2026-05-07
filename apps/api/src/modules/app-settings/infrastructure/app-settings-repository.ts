import type { Kysely } from 'kysely';
import type { AppSettings } from '@mangostudio/shared/app-settings';
import { normalizeAppSettings } from '@mangostudio/shared/app-settings';
import type { Database, UserAppSettingsSelect } from '../../../db/types';
import { safeJsonParse } from '../../../lib/safe-parse';
import { generateId } from '../../../utils/id';

export async function getSavedAppSettings(
  db: Kysely<Database>,
  userId: string
): Promise<AppSettings> {
  const row = await db
    .selectFrom('user_app_settings')
    .select(['settingsJson'])
    .where('userId', '=', userId)
    .executeTakeFirst();

  return parseAppSettingsRow(row);
}

export async function upsertAppSettings(
  db: Kysely<Database>,
  userId: string,
  settings: AppSettings
): Promise<AppSettings> {
  const now = Date.now();
  const normalized = normalizeAppSettings(settings);
  const settingsJson = JSON.stringify(normalized);

  await db
    .insertInto('user_app_settings')
    .values({
      id: generateId(),
      userId,
      settingsJson,
      createdAt: now,
      updatedAt: now,
    })
    .onConflict((oc) => oc.column('userId').doUpdateSet({ settingsJson, updatedAt: now }))
    .execute();

  return normalized;
}

function parseAppSettingsRow(
  row: Pick<UserAppSettingsSelect, 'settingsJson'> | undefined
): AppSettings {
  const parsed = safeJsonParse(row?.settingsJson);
  return normalizeAppSettings(parsed ?? undefined);
}
