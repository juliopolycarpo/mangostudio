/**
 * Bun test preload: configures the MangoConfig singleton before any test module
 * imports trigger lazy initialization of the database or auth singletons.
 *
 * Also runs migrations on the in-memory test database so that all tables exist.
 */
import { loadConfigForTest } from '../../../src/lib/config';
import { getDb } from '../../../src/db/database';
import { Migrator } from 'kysely';
import { allMigrations } from '../../../src/db/migrations';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Use a per-worker temp file so persistSecret and syncConfigFileConnectors
// share the same path without clobbering the real user config.
const testConfigPath = join(tmpdir(), `mangostudio-test-config-${process.pid}.toml`);
if (existsSync(testConfigPath)) unlinkSync(testConfigPath);

// 1. Set test config BEFORE any lazy singleton initializes
loadConfigForTest({
  auth: {
    secret: 'test-secret-at-least-32-characters-long',
    url: 'http://localhost:3001',
  },
  database: {
    path: ':memory:',
  },
  configFilePath: testConfigPath,
});

// 2. Run migrations on the singleton in-memory database
const db = getDb();
const migrator = new Migrator({
  db,
  provider: {
    getMigrations() {
      return Promise.resolve(allMigrations);
    },
  },
});

const { error } = await migrator.migrateToLatest();
if (error) {
  console.error('[test-preload] Migration failed:', error);
  process.exit(1);
}
