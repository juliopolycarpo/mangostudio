import type { Migration } from 'kysely/migration';

type JsonObject = Record<string, unknown>;

/**
 * Migration 033 — nest libraryLocations under profileSettings.default.
 *
 * Additive: the flat libraryLocations key stays in storage so a downgrade
 * still sees the pre-nesting shape, matching the existing skillSources mirror.
 */
export const profileScopedAppSettings: Migration = {
  async up(db): Promise<void> {
    const rows = await db.selectFrom('user_app_settings').select(['id', 'settingsJson']).execute();
    for (const row of rows) {
      const settingsJson = migrateProfileScopedAppSettings(row.settingsJson, 'up');
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
      const settingsJson = migrateProfileScopedAppSettings(row.settingsJson, 'down');
      if (settingsJson === row.settingsJson) continue;
      await db
        .updateTable('user_app_settings')
        .set({ settingsJson })
        .where('id', '=', row.id)
        .execute();
    }
  },
};

export function migrateProfileScopedAppSettings(
  settingsJson: string,
  direction: 'up' | 'down'
): string {
  const parsed = parseObject(settingsJson);
  if (!parsed) return settingsJson;

  if (direction === 'up') {
    const existingProfileSettings = isObject(parsed.profileSettings)
      ? { ...parsed.profileSettings }
      : {};
    const defaultScoped = isObject(existingProfileSettings.default)
      ? { ...existingProfileSettings.default }
      : {};
    const libraryLocations = isObject(defaultScoped.libraryLocations)
      ? defaultScoped.libraryLocations
      : isObject(parsed.libraryLocations)
        ? parsed.libraryLocations
        : undefined;

    if (!libraryLocations) return settingsJson;

    return stableStringifyIfChanged(settingsJson, {
      ...parsed,
      profileSettings: {
        ...existingProfileSettings,
        default: {
          ...defaultScoped,
          libraryLocations,
        },
      },
    });
  }

  const { profileSettings: _removed, ...rest } = parsed;
  return stableStringifyIfChanged(settingsJson, rest);
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
