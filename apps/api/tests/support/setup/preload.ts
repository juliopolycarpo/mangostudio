/**
 * Bun test preload: configures the MangoConfig singleton before any test module
 * imports trigger lazy initialization of the database or auth singletons.
 *
 * Also runs migrations on the in-memory test database so that all tables exist.
 */

import { existsSync, unlinkSync } from 'fs';
import { Migrator } from 'kysely/migration';
import { tmpdir } from 'os';
import { join } from 'path';
import { getDb } from '../../../src/db/database';
import { allMigrations } from '../../../src/db/migrations';
import { loadConfigForTest } from '../../../src/lib/config';

// Use a per-worker temp file so persistSecret and syncConfigFileConnectors
// share the same path without clobbering the real user config.
const testConfigPath = join(tmpdir(), `mangostudio-test-config-${process.pid}.toml`);
try {
  if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
} catch (e: unknown) {
  if (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code: string }).code !== 'ENOENT'
  ) {
    throw e;
  }
}

const testDbPath = join(tmpdir(), `mangostudio-test-${process.env.BUN_WORKER_ID || '0'}.sqlite`);
try {
  if (existsSync(testDbPath)) unlinkSync(testDbPath);
} catch (e: unknown) {
  if (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code: string }).code !== 'ENOENT'
  ) {
    throw e;
  }
}

// 1. Set test config BEFORE any lazy singleton initializes
loadConfigForTest({
  auth: {
    secret: 'test-secret-at-least-32-characters-long',
    url: 'http://localhost:3001',
  },
  database: {
    path: testDbPath,
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
