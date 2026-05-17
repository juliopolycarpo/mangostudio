/**
 * Bun test preload: configures the MangoConfig singleton before any test module
 * imports trigger lazy initialization of the database or auth singletons.
 *
 * Also runs migrations on the in-memory test database so that all tables exist.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Migrator } from 'kysely/migration';
import { getDb } from '../../../src/db/database';
import { allMigrations } from '../../../src/db/migrations';
import { loadConfigForTest } from '../../../src/lib/config';

const testRuntimeDir = mkdtempSync(
  join(tmpdir(), `mangostudio-test-${process.pid}-${process.env.BUN_WORKER_ID ?? '0'}-`)
);
const testConfigPath = join(testRuntimeDir, 'config.toml');
const testDbPath = join(testRuntimeDir, 'database.sqlite');

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
