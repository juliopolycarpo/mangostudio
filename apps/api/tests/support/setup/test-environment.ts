/**
 * Canonical Bun-test environment bootstrap, shared by the bunfig preload and
 * the test harness. One place owns the invariants every API test depends on:
 *
 *   1. The config singleton points at an isolated in-memory database and a
 *      managed temp config file — never the developer's real ~/.mango.
 *   2. All providers and tools are registered.
 *   3. The schema is migrated onto that in-memory database.
 *   4. The managed config file is reset between tests, so a config-file
 *      connector written by one test cannot leak into another test's reads.
 *
 * ## Bun preload await gotcha
 *
 * Bun does NOT block test-module loading on a preload's top-level `await`:
 * test files begin evaluating the moment the preload suspends. Anything a test
 * module needs at evaluation time (config + service registration) must
 * therefore run synchronously, before this function's first `await`. Migrations
 * may complete later — they only need to finish before the first test *runs*,
 * which is after the preload promise resolves.
 */

import { afterEach, beforeEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { DEFAULT_LIBRARY_LOCATION_SETTINGS } from '@mangostudio/shared/app-settings';
import { Migrator } from 'kysely/migration';
import { getDb } from '../../../src/db/database';
import { allMigrations } from '../../../src/db/migrations';
import {
  loadConfigForTest,
  TEST_MANAGED_CONFIG_DIR,
  TEST_MANAGED_CONFIG_PATH,
} from '../../../src/lib/config';
import { setLibraryLocationDefaultsForTest } from '../../../src/modules/app-settings/application/app-settings-service';
import { setProviderSecretSyncTtlForTest } from '../../../src/services/providers/core/secret-service';
import { registerApplicationServices } from '../../../src/services/register-application-services';

/** Set synchronously once config + services are in place (DB migrations follow). */
let initialized = false;
/** Memoizes the one-time async setup so repeated calls share a single run. */
let setupPromise: Promise<void> | null = null;

/** Installs the canonical isolated test config singleton. Synchronous + idempotent. */
function installBaseTestConfig(): void {
  setLibraryLocationDefaultsForTest(DEFAULT_LIBRARY_LOCATION_SETTINGS);
  setProviderSecretSyncTtlForTest(0);
  loadConfigForTest({
    auth: {
      secret: 'test-secret-at-least-32-characters-long',
      url: 'http://localhost:3001',
    },
    database: { path: ':memory:' },
    configFilePath: TEST_MANAGED_CONFIG_PATH,
  });
}

/**
 * Removes the managed config file so a config-file connector written during one
 * test cannot be read by the next. The directory is recreated so config writers
 * (which expect a parent dir) keep working.
 */
function resetManagedConfigFile(): void {
  rmSync(TEST_MANAGED_CONFIG_DIR, { recursive: true, force: true });
  mkdirSync(TEST_MANAGED_CONFIG_DIR, { recursive: true });
}

/** Runs every migration against the in-memory test database. */
async function migrateTestDatabase(): Promise<void> {
  const migrator = new Migrator({
    db: getDb(),
    provider: { getMigrations: () => Promise.resolve(allMigrations) },
  });

  const { error } = await migrator.migrateToLatest();
  if (error) {
    console.error('[test-environment] Migration failed:', error);
    process.exit(1);
  }
}

/**
 * Prepares the shared test environment exactly once per process.
 * // Usage: await setupTestEnvironment()
 */
export function setupTestEnvironment(): Promise<void> {
  if (setupPromise) return setupPromise;

  // Synchronous phase — must complete before the first `await` below so test
  // modules see config + registered services as soon as the preload suspends.
  resetManagedConfigFile();
  installBaseTestConfig();
  registerApplicationServices();
  initialized = true;

  // Per-test isolation. beforeEach reinstalls the canonical config so no test
  // inherits another's overrides; afterEach clears the managed config file so
  // config-file connector writes never leak forward. A test that needs custom
  // config still overrides it in its own beforeEach (which runs after this one).
  beforeEach(installBaseTestConfig);
  afterEach(resetManagedConfigFile);

  setupPromise = migrateTestDatabase();
  return setupPromise;
}

/**
 * Throws an actionable error when the test environment was never initialized —
 * almost always because tests were started from the wrong directory, so Bun
 * never loaded the workspace `bunfig.toml` preload.
 * // Usage: assertTestEnvironmentReady('createApiTestApp')
 */
export function assertTestEnvironmentReady(usage: string): void {
  if (initialized) return;

  throw new Error(
    `${usage} was called before the API test environment was initialized. ` +
      'This usually means the test runner did not load the preload, which happens ' +
      'when API tests are started from the repository root. Run them from the ' +
      'workspace instead:\n' +
      '  bun run --filter @mangostudio/api test:unit\n' +
      '  bun run --filter @mangostudio/api test:integration\n' +
      'or `cd apps/api && bun test`. See docs/reference/testing.md.'
  );
}
