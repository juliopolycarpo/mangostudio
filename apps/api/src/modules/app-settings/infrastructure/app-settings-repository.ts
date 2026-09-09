import type {
  AppSettings,
  AppSettingsPutBody,
  LibraryLocationSettings,
} from '@mangostudio/shared/app-settings';
import {
  libraryLocationsFor,
  mergeAppSettingsPatch,
  normalizeAppSettings,
} from '@mangostudio/shared/app-settings';
import type { Kysely } from 'kysely';
import type { Database, UserAppSettingsSelect } from '../../../db/types';
import { safeJsonParse } from '../../../lib/safe-parse';
import { generateId } from '../../../utils/id';

export async function getSavedAppSettings(
  db: Kysely<Database>,
  userId: string,
  libraryLocationDefaults?: LibraryLocationSettings
): Promise<AppSettings> {
  const row = await db
    .selectFrom('user_app_settings')
    .select(['settingsJson'])
    .where('userId', '=', userId)
    .executeTakeFirst();

  return parseAppSettingsRow(row, libraryLocationDefaults);
}

/**
 * Apply a settings patch to the row this user already has.
 *
 * Read, merge, normalize, write — in that order, and inside one call so the
 * stored value the patch lands on is the newest one rather than whatever the
 * client last saw. Normalizing *after* the merge is what gives `null` its
 * meaning: the normalizer maps a missing subtree to its default, so an explicit
 * clear and a never-set field arrive at the same place.
 *
 * @example
 * await patchAppSettings(db, user.id, { thinkingEnabled: false });
 */
export async function patchAppSettings(
  db: Kysely<Database>,
  userId: string,
  patch: AppSettingsPutBody,
  libraryLocationDefaults?: LibraryLocationSettings
): Promise<AppSettings> {
  const now = Date.now();
  const existing = await db
    .selectFrom('user_app_settings')
    .select('settingsJson')
    .where('userId', '=', userId)
    .executeTakeFirst();
  const persisted = safeJsonParse(existing?.settingsJson);
  const preserved = isRecord(persisted) ? persisted : {};
  const normalized = normalizeAppSettings(
    mergeAppSettingsPatch(preserved, patch),
    libraryLocationDefaults
  );
  const locations = libraryLocationsFor(normalized);
  const settingsJson = JSON.stringify({
    ...preserved,
    ...normalized,
    // Keep the pre-nesting and pre-library shapes in storage so an application
    // downgrade retains the two source choices even though they are no longer
    // public API. Both mirrors are flat because both predate scope, and every
    // location they can name is home-scoped.
    libraryLocations: locations.home,
    skillSources: {
      agents: locations.home['agents-skills'] ?? false,
      claude: locations.home['claude-skills'] ?? false,
    },
  });

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
  row: Pick<UserAppSettingsSelect, 'settingsJson'> | undefined,
  libraryLocationDefaults?: LibraryLocationSettings
): AppSettings {
  const parsed = safeJsonParse(row?.settingsJson);
  return normalizeAppSettings(parsed ?? undefined, libraryLocationDefaults);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
