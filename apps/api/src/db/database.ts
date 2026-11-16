/**
 * Kysely database singleton using Bun's native SQLite.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Kysely } from 'kysely';

import { getConfig } from '../lib/config';
import { createDiagnosticLogger } from '../lib/logger';
import { createBunSqliteDialect } from './bun-sqlite-dialect';
import type { Database } from './types';

let dbInstance: Kysely<Database> | null = null;
const dbLogger = createDiagnosticLogger('db');

/**
 * Sets the connection pragmas the hub relies on.
 *
 * A file database runs in WAL mode. `synchronous` stays at SQLite's default,
 * `FULL`, here: the hub lowers it with `relaxDurability` only after its
 * migrations have finished (see `db/durability.ts`), because Kysely's SQLite
 * adapter does not run a migration in a transaction and a lost bookkeeping row
 * would make the next start re-run a migration that is not idempotent.
 *
 * @example applyConnectionPragmas(new Database(path), path);
 */
export function applyConnectionPragmas(sqlite: SQLiteDatabase, dbPath: string): void {
  if (dbPath !== ':memory:') sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
}

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
    applyConnectionPragmas(sqlite, dbPath);

    dbInstance = new Kysely<Database>({
      dialect: createBunSqliteDialect(sqlite),
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
