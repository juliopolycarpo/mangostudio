/**
 * Database migration runner using Kysely Migrator.
 * Run with: bun run src/db/migrate.ts
 */

import { Migrator } from 'kysely';
import { getDb, closeDb } from './database';
import { initialSchema } from './migrations/001_initial_schema';
import { addInteractionMode } from './migrations/002_add_interaction_mode';
import { addSecretMetadata } from './migrations/003_add_secret_metadata';
import { addIndexes } from './migrations/004_add_indexes';
import { multiConnectors } from './migrations/005_multi_connectors';
import { authTables } from './migrations/006_auth_tables';
import { addUserOwnership } from './migrations/007_add_user_ownership';
import { providerFields } from './migrations/008_provider_fields';

async function migrateToLatest(): Promise<void> {
  const db = getDb();

  const migrator = new Migrator({
    db,
    provider: {
      async getMigrations() {
        return {
          '001_initial_schema': initialSchema,
          '002_add_interaction_mode': addInteractionMode,
          '003_add_secret_metadata': addSecretMetadata,
          '004_add_indexes': addIndexes,
          '005_multi_connectors': multiConnectors,
          '006_auth_tables': authTables,
          '007_add_user_ownership': addUserOwnership,
          '008_provider_fields': providerFields,
        };
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
