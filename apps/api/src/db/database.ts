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
/** The handle behind `dbInstance`, kept so `closeDb` can release the file itself. */
let sqliteHandle: SQLiteDatabase | null = null;
const dbLogger = createDiagnosticLogger('db');

/**
 * Sets the connection pragmas the hub relies on.
 *
 * A file database runs in WAL mode. `synchronous` is set to `FULL` here, after
 * the WAL switch, instead of trusting the library default: the hub lowers it with
 * `relaxDurability` only after its migrations have finished (see
 * `db/durability.ts`), because Kysely's SQLite adapter does not run a migration
 * in a transaction and a lost bookkeeping row would make the next start re-run a
 * migration that is not idempotent. The default is not `FULL` everywhere: macOS
 * links Apple's SQLite, built with `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`, which
 * lowers a connection to `NORMAL` when it first enters WAL mode unless the level
 * was set by a pragma. Setting it after the switch holds on every build.
 *
 * @example applyConnectionPragmas(new Database(path), path);
 */
export function applyConnectionPragmas(sqlite: SQLiteDatabase, dbPath: string): void {
  if (dbPath !== ':memory:') sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA synchronous = FULL;');
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
    sqliteHandle = sqlite;
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
    // Kysely opens its driver on the first query and closes the database only if it did, so
    // an instance that never ran one would keep the file open. Windows cannot move or delete
    // an open database file (backup restore, upgrade), so close the handle explicitly.
    sqliteHandle?.close(true);
    sqliteHandle = null;
    dbInstance = null;
    dbLogger.info('closed');
  }
}
