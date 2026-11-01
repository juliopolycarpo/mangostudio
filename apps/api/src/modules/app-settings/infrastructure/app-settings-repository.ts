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
import { AppSettingsConflict } from '../domain/app-settings-conflict';

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
 * Read, merge, normalize, then compare-and-swap the exact stored JSON. A
 * competing writer makes this call fail explicitly instead of overwriting the
 * winner. A fresh call must re-read and apply only the intended patch.
 * Normalizing *after* the merge is what gives `null` its
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
    // A fresh opaque version prevents ABA (including equal-millisecond writes
    // and writes that normalize to the same preferences). It stays private to
    // storage; timestamps are not revision identifiers.
    _writeVersion: generateId(),
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
