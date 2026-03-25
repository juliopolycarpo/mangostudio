/**
 * Kysely database singleton using Bun's native SQLite.
 */

import { Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as SQLiteDatabase } from 'bun:sqlite';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';
import type { Database } from './types';
import { getDefaultDatabaseFallbackPath } from '../lib/runtime-paths';

function getDatabasePath(): string {
  // 1. Environment variable
  if (process.env.DATABASE_PATH) {
    return process.env.DATABASE_PATH;
  }

  // 2. User data directory (~/.mangostudio/database.sqlite)
  const userDataPath = join(homedir(), '.mangostudio', 'database.sqlite');

  // Try to use user data directory, fall back to current directory
  try {
    const userDataDir = dirname(userDataPath);
    // Create directory if it doesn't exist
    mkdirSync(userDataDir, { recursive: true });
    return userDataPath;
  } catch {
    // 3. Runtime-aware filesystem fallback
    return getDefaultDatabaseFallbackPath();
  }
}

const DB_PATH = getDatabasePath();

let dbInstance: Kysely<Database> | null = null;

/**
 * Returns the singleton Kysely database instance.
 * Creates it on first call with WAL mode enabled.
 */
export function getDb(): Kysely<Database> {
  if (!dbInstance) {
    const sqlite = new SQLiteDatabase(DB_PATH);
    sqlite.exec('PRAGMA journal_mode = WAL;');
    sqlite.exec('PRAGMA foreign_keys = ON;');

    dbInstance = new Kysely<Database>({
      dialect: new BunSqliteDialect({ database: sqlite }),
    });

    console.log(`[db] Connected to SQLite at ${DB_PATH}`);
  }
  return dbInstance;
}

/**
 * Gracefully closes the database connection.
 */
export async function closeDb(): Promise<void> {
  if (dbInstance) {
    await dbInstance.destroy();
    dbInstance = null;
    console.log('[db] Connection closed');
  }
}
