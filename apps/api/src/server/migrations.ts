/**
 * Database migration runner executed before the server starts listening.
 */

import { type MigrationResult, Migrator } from 'kysely/migration';
import { getDb } from '../db/database';
import { allMigrations } from '../db/migrations';

/** Migrate the database to the latest schema; exit(1) on failure. // Usage: await runMigrations() */
export async function runMigrations(): Promise<void> {
  const migrator = new Migrator({
    db: getDb(),
    provider: { getMigrations: () => Promise.resolve(allMigrations) },
  });

  const { error, results } = await migrator.migrateToLatest();
  reportMigrationResults(results);

  if (error) {
    console.error('[migrate] Migration failed:', error);
    process.exit(1);
  }
}

/** Print a per-migration success/failure line. */
function reportMigrationResults(results: MigrationResult[] | undefined): void {
  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.warn(`[migrate] ✓ "${it.migrationName}"`);
    } else if (it.status === 'Error') {
      console.error(`[migrate] ✗ "${it.migrationName}" failed`);
    }
  });
}
