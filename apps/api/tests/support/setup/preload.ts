/**
 * Bun test preload: configures the MangoConfig singleton before any test module
 * imports trigger lazy initialization of the database or auth singletons.
 *
 * Also runs migrations on the in-memory test database so that all tables exist.
 */
import { loadConfigForTest } from '../../../src/lib/config';
import { getDb } from '../../../src/db/database';
import { Migrator } from 'kysely';
import { initialSchema } from '../../../src/db/migrations/001_initial_schema';
import { addInteractionMode } from '../../../src/db/migrations/002_add_interaction_mode';
import { addSecretMetadata } from '../../../src/db/migrations/003_add_secret_metadata';
import { addIndexes } from '../../../src/db/migrations/004_add_indexes';
import { multiConnectors } from '../../../src/db/migrations/005_multi_connectors';
import { authTables } from '../../../src/db/migrations/006_auth_tables';
import { addUserOwnership } from '../../../src/db/migrations/007_add_user_ownership';

// 1. Set test config BEFORE any lazy singleton initializes
loadConfigForTest({
  auth: {
    secret: 'test-secret-at-least-32-characters-long',
    url: 'http://localhost:3001',
  },
  database: {
    path: ':memory:',
  },
});

// 2. Run migrations on the singleton in-memory database
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
      };
    },
  },
});

const { error } = await migrator.migrateToLatest();
if (error) {
  console.error('[test-preload] Migration failed:', error);
  process.exit(1);
}
