import { createHash } from 'node:crypto';

import type {
  AppSettings,
  AppSettingsPutBody,
  AppSettingsResponse,
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
import { AppSettingsConflict } from '../domain/app-settings-conflict';

/** Read normalized preferences without HTTP response metadata.
 * @example const settings = await getSavedAppSettings(db, user.id);
 */
export async function getSavedAppSettings(
  db: Kysely<Database>,
  userId: string,
  libraryLocationDefaults?: LibraryLocationSettings
): Promise<AppSettings> {
  return parseAppSettingsRow(await readAppSettingsRow(db, userId), libraryLocationDefaults);
}

type AppSettingsSnapshot = {
  readonly settings: AppSettings;
  readonly revision: AppSettingsResponse['revision'];
};

/** Read preferences and the revision of the same stored row without writing.
 * @example const { settings, revision } = await getSavedAppSettingsSnapshot(db, user.id);
 */
export async function getSavedAppSettingsSnapshot(
  db: Kysely<Database>,
  userId: string,
  libraryLocationDefaults?: LibraryLocationSettings
): Promise<AppSettingsSnapshot> {
  const row = await readAppSettingsRow(db, userId);
  return {
    settings: parseAppSettingsRow(row, libraryLocationDefaults),
    revision: rowRevision(row),
  };
}

/**
 * Apply a settings patch to the row this user already has.
 *
 * Read, merge, normalize, then compare-and-swap the exact stored JSON. A
 * competing writer makes this call fail explicitly instead of overwriting the
 * winner. A fresh call must re-read and apply only the intended patch.
 * Normalizing *after* the merge is what gives `null` its
 * meaning: the normalizer maps a missing subtree to its default, so an explicit
 * clear and a never-set field arrive at the same place.
 *
 * @example
 * await patchAppSettingsSnapshot(db, user.id, { thinkingEnabled: false }, undefined, revision);
 */
export async function patchAppSettingsSnapshot(
  db: Kysely<Database>,
  userId: string,
  patch: AppSettingsPutBody,
  libraryLocationDefaults?: LibraryLocationSettings,
  expectedRevision?: string
): Promise<AppSettingsSnapshot> {
  const now = Date.now();
  const existing = await db
    .selectFrom('user_app_settings')
    .select('settingsJson')
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (expectedRevision !== undefined && expectedRevision !== rowRevision(existing)) {
    throw new AppSettingsConflict();
  }
  const revision = `"${generateId()}"`;
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
    // A fresh opaque version prevents ABA (including equal-millisecond writes
    // and writes that normalize to the same preferences). The private storage
    // key is omitted from preferences; the token travels as response metadata.
    _writeVersion: revision,
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

  const written = existing
    ? await db
        .updateTable('user_app_settings')
        .set({ settingsJson, updatedAt: now })
        .where('userId', '=', userId)
        .where('settingsJson', '=', existing.settingsJson)
        .returning('id')
        .executeTakeFirst()
    : await db
        .insertInto('user_app_settings')
        .values({
          id: generateId(),
          userId,
          settingsJson,
          createdAt: now,
          updatedAt: now,
        })
        .onConflict((oc) => oc.column('userId').doNothing())
        .returning('id')
        .executeTakeFirst();

  // Never retry a stale subtree automatically: it may contain an older
  // onboarding step or a location choice another writer just changed.
  if (!written) throw new AppSettingsConflict();

  return { settings: normalized, revision };
}

/** Apply a patch for an internal caller without a client revision precondition.
 * @example await patchAppSettings(db, user.id, { thinkingEnabled: false });
 */
export async function patchAppSettings(
  db: Kysely<Database>,
  userId: string,
  patch: AppSettingsPutBody,
  libraryLocationDefaults?: LibraryLocationSettings
): Promise<AppSettings> {
  return (await patchAppSettingsSnapshot(db, userId, patch, libraryLocationDefaults)).settings;
}

function readAppSettingsRow(db: Kysely<Database>, userId: string) {
  return db
    .selectFrom('user_app_settings')
    .select('settingsJson')
    .where('userId', '=', userId)
    .executeTakeFirst();
}

function rowRevision(row: Pick<UserAppSettingsSelect, 'settingsJson'> | undefined): string {
  if (!row) return '"absent"';
  const parsed = safeJsonParse(row.settingsJson);
  // Hash legacy rows too: reads cannot mutate them to create a version, and
  // their timestamp need not change when their stored preferences do.
  if (isRecord(parsed) && typeof parsed._writeVersion === 'string') {
    return parsed._writeVersion.startsWith('"')
      ? parsed._writeVersion
      : `"${parsed._writeVersion}"`;
  }
  return `"legacy-${createHash('sha256').update(row.settingsJson).digest('hex')}"`;
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
