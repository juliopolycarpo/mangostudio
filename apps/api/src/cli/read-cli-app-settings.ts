/**
 * Read persisted AppSettings for CLI commands without opening a Kysely session.
 * Mirrors doctor's readonly SQLite probes: never create or migrate the database.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import {
  type AppSettings,
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
} from '@mangostudio/shared/app-settings';
import { loadConfig, type MangoConfig } from '../lib/config';
import { safeJsonParse } from '../lib/safe-parse';

/**
 * Returns the first persisted `user_app_settings` row as AppSettings.
 * Falls back to defaults when the DB is missing, empty, or unreadable.
 */
export function readCliAppSettings(
  config: MangoConfig = loadConfig(),
  defaults: AppSettings = DEFAULT_APP_SETTINGS
): AppSettings {
  const rows = readReadonlyDbRows<{ settingsJson: string }>(
    config,
    'SELECT settingsJson FROM user_app_settings LIMIT 1'
  );
  const parsed = safeJsonParse(rows[0]?.settingsJson);
  if (!parsed) return defaults;
  return normalizeAppSettings(parsed);
}

function readReadonlyDbRows<T>(config: MangoConfig, query: string): T[] {
  const dbPath = config.database.path;
  if (dbPath === ':memory:' || !existsSync(dbPath)) return [];

  let db: SQLiteDatabase | null = null;
  try {
    db = new SQLiteDatabase(dbPath, { readonly: true });
    return db.query(query).all() as unknown as T[];
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
