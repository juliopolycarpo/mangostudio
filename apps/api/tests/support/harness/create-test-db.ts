import { Database as SQLiteDatabase } from 'bun:sqlite';
import { Kysely, Migrator } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { addInteractionMode } from '../../../src/db/migrations/002_add_interaction_mode';
import { addIndexes } from '../../../src/db/migrations/004_add_indexes';
import { initialSchema } from '../../../src/db/migrations/001_initial_schema';
import { addSecretMetadata } from '../../../src/db/migrations/003_add_secret_metadata';
import type { Database } from '../../../src/db/types';

/**
 * Creates a fresh in-memory SQLite database for tests.
 *
 * @returns A new Kysely database instance backed by an in-memory SQLite database.
 */
export function createTestDb(): Kysely<Database> {
  const sqlite = new SQLiteDatabase(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');

  return new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: sqlite }),
  });
}

/**
 * Runs the production migrations against a test database.
 *
 * @param db - The test database to migrate.
 */
export async function migrateTestDb(db: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: {
      async getMigrations() {
        return {
          '001_initial_schema': initialSchema,
          '002_add_interaction_mode': addInteractionMode,
          '003_add_secret_metadata': addSecretMetadata,
          '004_add_indexes': addIndexes,
        };
      },
    },
  });

  const { error } = await migrator.migrateToLatest();

  if (error) {
    console.error('Failed to migrate test database:', error);
    throw error;
  }
}
