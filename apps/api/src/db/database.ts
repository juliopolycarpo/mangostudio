/**
 * Kysely database singleton using Bun's native SQLite.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite/dist/index.js';
import { getConfig } from '../lib/config';
import { createDiagnosticLogger } from '../lib/logger';
import type { Database } from './types';

let dbInstance: Kysely<Database> | null = null;
const dbLogger = createDiagnosticLogger('db');

/**
 * Returns the singleton Kysely database instance.
 * Creates it on first call with WAL mode enabled.
 */
export function getDb(): Kysely<Database> {
  if (!dbInstance) {
    const dbPath = getConfig().database.path;

    // Ensure parent directory exists
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch {
      // Directory already exists or permission issue — proceed and let SQLite handle it
    }

    const sqlite = new SQLiteDatabase(dbPath);
    if (dbPath !== ':memory:') sqlite.exec('PRAGMA journal_mode = WAL;');
    sqlite.exec('PRAGMA foreign_keys = ON;');

    dbInstance = new Kysely<Database>({
      dialect: new BunSqliteDialect({ database: sqlite }),
    });

    dbLogger.info('connected', { path: dbPath });
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
    dbLogger.info('closed');
  }
}
