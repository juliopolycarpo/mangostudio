/**
 * Database migration runner executed before the server starts listening.
 */

import { type MigrationResult, Migrator } from 'kysely/migration';

import { acquireCaptureLock } from '../backup/capture-lock';
import { getDb } from '../db/database';
import { relaxDurability } from '../db/durability';
import { allMigrations } from '../db/migrations';
import { getConfig } from '../lib/config';

function createMigrator(db: ReturnType<typeof getDb>): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(allMigrations) },
  });
}

const TOOLCHAIN_REVISION_MIGRATION = '062_environment_toolchain_revision';

async function hasToolchainRevisionMigration(migrator: Migrator): Promise<boolean> {
  return (await migrator.getMigrations()).some(
    ({ name, executedAt }) => name === TOOLCHAIN_REVISION_MIGRATION && executedAt !== undefined
  );
}

/**
 * Upgrades an offline database for a remote toolchain pin using the same
 * ownership lock as Hub startup. An already upgraded database needs no lock.
 * @example await prepareToolchainDatabase()
 */
export async function prepareToolchainDatabase(
  db = getDb(),
  path = getConfig().database.path
): Promise<void> {
  const migrator = createMigrator(db);
  if (await hasToolchainRevisionMigration(migrator)) return;
  let release: (() => Promise<void>) | undefined;
  try {
    if (path !== ':memory:') release = await acquireCaptureLock(path);
  } catch (error) {
    if (await hasToolchainRevisionMigration(migrator)) return;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The database needs an upgrade. Stop the Hub and retry after any backup has finished. ${detail}`,
      { cause: error }
    );
  }

  try {
    await runMigrations(db);
  } finally {
    await release?.();
  }
}

/**
 * Migrate the database to the latest schema; exit(1) on failure. The pending
 * migrations run as one transaction (the Bun SQLite dialect reports transactional
 * DDL), so a failure, crash or power loss leaves the schema and the
 * `kysely_migration` rows exactly as they were before the batch. They run while
 * the connection still syncs every commit, and only then does it drop to
 * `synchronous = NORMAL`: at `FULL` the whole batch costs one fsync, and the
 * committed schema is on disk before the hub serves a request.
 * // Usage: await runMigrations()
 */
export async function runMigrations(db = getDb()): Promise<void> {
  const { error, results } = await createMigrator(db).migrateToLatest();
  reportMigrationResults(results, error !== undefined);

  if (error) {
    console.error('[migrate] Migration failed, batch rolled back:', error);
    process.exit(1);
  }
  await relaxDurability(db);
}

/**
 * Print a per-migration success/failure line. When the batch failed, the migrations
 * Kysely reports as `Success` ran inside the transaction that was rolled back, so
 * they are reported as rolled back rather than applied.
 */
function reportMigrationResults(
  results: MigrationResult[] | undefined,
  batchFailed: boolean
): void {
  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.warn(
        batchFailed
          ? `[migrate] ↩ "${it.migrationName}" rolled back with the batch`
          : `[migrate] ✓ "${it.migrationName}"`
      );
    } else if (it.status === 'Error') {
      console.error(`[migrate] ✗ "${it.migrationName}" failed`);
    }
  });
}
