/**
 * Bun test preload: configures the MangoConfig singleton before any test module
 * imports trigger lazy initialization of the database or auth singletons.
 *
 * Also registers providers/tools and runs migrations on the in-memory test
 * database so that all tables exist and all runtime services are available
 * when test modules evaluate their top-level code.
 *
 * IMPORTANT: registerApplicationServices() must run before any async
 * operation because top-level await in a Bun preload does NOT block test
 * module loading — test module evaluation starts as soon as the preload
 * hits its first await expression.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Migrator } from 'kysely/migration';
import { getDb } from '../../../src/db/database';
import { allMigrations } from '../../../src/db/migrations';
import { loadConfigForTest } from '../../../src/lib/config';
import { registerApplicationServices } from '../../../src/services/register-application-services';

const testRuntimeDir = mkdtempSync(
  join(tmpdir(), `mangostudio-test-${process.pid}-${process.env.BUN_WORKER_ID ?? '0'}-`)
);
const testConfigPath = join(testRuntimeDir, 'config.toml');

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

// 2. Register providers and tools synchronously, before the first await.
//    This must happen here because Bun does not block on preload top-level
//    await; test modules begin loading as soon as the preload suspends.
registerApplicationServices();

// 3. Run migrations on the singleton in-memory database
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
