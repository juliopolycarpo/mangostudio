import type { AppSettings } from '@mangostudio/shared/app-settings';
import { normalizeAppSettings } from '@mangostudio/shared/app-settings';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { getSavedAppSettings, upsertAppSettings } from '../infrastructure/app-settings-repository';

// biome-ignore lint/suspicious/useAwait: Migrated from ESLint
export async function getAppSettings(db: Kysely<Database>, userId: string): Promise<AppSettings> {
  return getSavedAppSettings(db, userId);
}

// biome-ignore lint/suspicious/useAwait: Migrated from ESLint
export async function updateAppSettings(
  db: Kysely<Database>,
  userId: string,
  settings: AppSettings
): Promise<AppSettings> {
  return upsertAppSettings(db, userId, normalizeAppSettings(settings));
}
