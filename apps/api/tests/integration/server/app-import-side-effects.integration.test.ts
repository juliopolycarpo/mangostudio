import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Pins what merely *importing* `src/app.ts` is allowed to do to the machine.
 *
 * Route factories are called at module scope, so anything they eagerly
 * construct runs during import — for anything that imports the app, not just a
 * server that is about to start. Repository factories used to default their
 * database argument to `getDb()`, which opened SQLite and created
 * `~/.mango/database.sqlite` at import time, before `runMigrations()` had run.
 * Nothing failed, so nothing caught it.
 *
 * A subprocess with its own HOME is the only honest way to assert this: module
 * evaluation happens once per process, and the test runner has already imported
 * half of these modules by the time this file runs.
 */

const ENTRY = join(import.meta.dir, '../../../src/app.ts');
const IMPORT_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 90_000;

interface ImportResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly home: string;
  readonly databaseExists: boolean;
  readonly uploadsExists: boolean;
}

/**
 * Import the app in a throwaway HOME and report what it left behind. The
 * uploads/images directories are redirected out of `~/.mango` as well, so a
 * regression is visible as a path under `home` rather than a write to the
 * developer's real MangoStudio directory.
 */
async function importAppInIsolatedHome(): Promise<ImportResult> {
  const home = await mkdtemp(join(tmpdir(), 'mango-import-'));
  const databasePath = join(home, '.mango', 'database.sqlite');
  const uploadsDir = join(home, 'uploads');

  const child = Bun.spawn(['bun', '-e', `await import(${JSON.stringify(ENTRY)})`], {
    env: {
      ...(process.env as Record<string, string>),
      NODE_ENV: 'production',
      HOME: home,
      MANGO_HOME: home,
      DATABASE_PATH: databasePath,
      UPLOADS_DIR: uploadsDir,
      IMAGES_DIR: join(home, 'images'),
      TOOL_IMAGES_DIR: join(home, 'tool-images'),
      MANGOSTUDIO_DIAGNOSTIC_LOGS: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await Promise.race([
    child.exited,
    Bun.sleep(IMPORT_TIMEOUT_MS).then(() => {
      child.kill('SIGKILL');
      return -1;
    }),
  ]);
  const stderr = await new Response(child.stderr).text();

  return {
    exitCode,
    stderr,
    home,
    databaseExists: existsSync(databasePath),
    uploadsExists: existsSync(uploadsDir),
  };
}

describe('importing src/app.ts', () => {
  it(
    'opens no database and creates only the directory the static plugin needs',
    async () => {
      const result = await importAppInIsolatedHome();
      try {
        expect(result.stderr).not.toContain('error:');
        expect(result.exitCode).toBe(0);

        // The regression this file exists for: a repository factory that
        // defaults its `db` argument to `getDb()` and is called at module
        // scope connects here, long before the server decides to start.
        expect(result.databaseExists).toBe(false);

        // The other half of the contract, and the reason this is not simply
        // "importing writes nothing": `staticPlugin` enumerates its assets
        // directory while `.use()` evaluates, and Bun.Glob throws on a missing
        // one — so the uploads directory must exist by the end of the import,
        // or `app.listen()` fails instead of serving nothing.
        expect(result.uploadsExists).toBe(true);
      } finally {
        await rm(result.home, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );
});
