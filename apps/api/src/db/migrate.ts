/**
 * Database migration runner using Kysely Migrator.
 * Run with: bun run src/db/migrate.ts
 */

import { Migrator } from 'kysely';
import { getDb, closeDb } from './database';
import { allMigrations } from './migrations';

async function migrateToLatest(): Promise<void> {
  const db = getDb();

  const migrator = new Migrator({
    db,
    provider: {
      async getMigrations() {
        return allMigrations;
      },
    },
  });

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.log(`[migrate] ✓ "${it.migrationName}" executed successfully`);
    } else if (it.status === 'Error') {
      console.error(`[migrate] ✗ Failed to execute "${it.migrationName}"`);
    }
  });

  if (error) {
    console.error('[migrate] Migration failed:', error);
    await closeDb();
    process.exit(1);
  }

  console.log('[migrate] All migrations applied successfully');
  await closeDb();
}

void migrateToLatest();
