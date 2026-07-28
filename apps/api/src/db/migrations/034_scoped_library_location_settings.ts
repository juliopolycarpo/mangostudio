import type { Migration } from 'kysely/migration';

type JsonObject = Record<string, unknown>;

/**
 * Migration 034 — nest profileSettings.default.libraryLocations under scope.
 *
 * The third move of this key, after 030 created it and 033 nested it under a
 * profile. Every toggle it has ever held names a directory under the user's
 * home, so the whole flat map becomes the `home` scope and `workspace` starts
 * empty — v1 defines no location that resolves under a repository root.
 *
 * Additive in the same sense 033 is: the pre-nesting flat shapes stay in
 * storage, written on every save by the repository, so a downgrade still finds
 * the toggles where it expects them.
 */
export const scopedLibraryLocationSettings: Migration = {
  async up(db): Promise<void> {
    const rows = await db.selectFrom('user_app_settings').select(['id', 'settingsJson']).execute();
    for (const row of rows) {
      const settingsJson = migrateScopedLibraryLocationSettings(row.settingsJson, 'up');
      if (settingsJson === row.settingsJson) continue;
      await db
        .updateTable('user_app_settings')
        .set({ settingsJson })
        .where('id', '=', row.id)
        .execute();
    }
  },

  async down(db): Promise<void> {
    const rows = await db.selectFrom('user_app_settings').select(['id', 'settingsJson']).execute();
    for (const row of rows) {
      const settingsJson = migrateScopedLibraryLocationSettings(row.settingsJson, 'down');
      if (settingsJson === row.settingsJson) continue;
      await db
        .updateTable('user_app_settings')
        .set({ settingsJson })
        .where('id', '=', row.id)
        .execute();
    }
  },
};

const LIBRARY_SCOPE_KEYS = ['home', 'workspace'] as const;

/**
 * Nested rows hold objects under a scope key; flat rows hold booleans under
 * location ids. Checking the value's type rather than the key's presence keeps
 * a location that happens to be named `home` from reading as an already-nested
 * map.
 */
function isScoped(libraryLocations: JsonObject): boolean {
  return LIBRARY_SCOPE_KEYS.some((scope) => isObject(libraryLocations[scope]));
}

export function migrateScopedLibraryLocationSettings(
  settingsJson: string,
  direction: 'up' | 'down'
): string {
  const parsed = parseObject(settingsJson);
  if (!parsed) return settingsJson;

  const profileSettings = isObject(parsed.profileSettings) ? { ...parsed.profileSettings } : {};
  const defaultScoped = isObject(profileSettings.default) ? { ...profileSettings.default } : {};
  const libraryLocations = isObject(defaultScoped.libraryLocations)
    ? defaultScoped.libraryLocations
    : undefined;
  if (!libraryLocations) return settingsJson;

  const scoped = isScoped(libraryLocations);
  if (direction === 'up' ? scoped : !scoped) return settingsJson;

  const nextLocations = direction === 'up' ? nest(libraryLocations) : flatten(libraryLocations);

  return stableStringifyIfChanged(settingsJson, {
    ...parsed,
    profileSettings: {
      ...profileSettings,
      default: { ...defaultScoped, libraryLocations: nextLocations },
    },
  });
}

function nest(libraryLocations: JsonObject): JsonObject {
  return { home: libraryLocations, workspace: {} };
}

/**
 * Down drops every non-home scope. Nothing can be under one — no workspace
 * location exists to enable — and a flat map has no room to keep it if it were.
 */
function flatten(libraryLocations: JsonObject): JsonObject {
  return isObject(libraryLocations.home) ? libraryLocations.home : {};
}

function parseObject(value: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableStringifyIfChanged(original: string, value: JsonObject): string {
  const serialized = JSON.stringify(value);
  const originalValue = parseObject(original);
  return originalValue && JSON.stringify(originalValue) === serialized ? original : serialized;
}
