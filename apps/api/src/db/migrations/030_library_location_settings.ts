import type { Migration } from 'kysely/migration';

type JsonObject = Record<string, unknown>;

export const libraryLocationSettings: Migration = {
  async up(db): Promise<void> {
    const rows = await db.selectFrom('user_app_settings').select(['id', 'settingsJson']).execute();
    for (const row of rows) {
      const settingsJson = migrateLibraryLocationSettings(row.settingsJson, 'up');
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
      const settingsJson = migrateLibraryLocationSettings(row.settingsJson, 'down');
      if (settingsJson === row.settingsJson) continue;
      await db
        .updateTable('user_app_settings')
        .set({ settingsJson })
        .where('id', '=', row.id)
        .execute();
    }
  },
};

export function migrateLibraryLocationSettings(
  settingsJson: string,
  direction: 'up' | 'down'
): string {
  const parsed = parseObject(settingsJson);
  if (!parsed) return settingsJson;

  const libraryLocations = isObject(parsed.libraryLocations) ? { ...parsed.libraryLocations } : {};
  const skillSources = isObject(parsed.skillSources) ? { ...parsed.skillSources } : {};

  if (direction === 'up') {
    libraryLocations['mango-skills'] = true;
    copyBoolean(skillSources, 'agents', libraryLocations, 'agents-skills');
    copyBoolean(skillSources, 'claude', libraryLocations, 'claude-skills');
    return stableStringifyIfChanged(settingsJson, {
      ...parsed,
      libraryLocations,
      skillSources,
    });
  }

  copyBoolean(libraryLocations, 'agents-skills', skillSources, 'agents');
  copyBoolean(libraryLocations, 'claude-skills', skillSources, 'claude');
  return stableStringifyIfChanged(settingsJson, {
    ...parsed,
    libraryLocations,
    skillSources,
  });
}

function copyBoolean(source: JsonObject, from: string, destination: JsonObject, to: string): void {
  if (typeof source[from] === 'boolean') destination[to] = source[from];
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
