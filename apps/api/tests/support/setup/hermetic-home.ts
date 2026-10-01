/**
 * Aborts the test lane when it is running with the developer's real home.
 *
 * The lane launcher (`scripts/with-test-home.ts`) starts `bun test` with
 * `HOME` pointing at a temporary directory and records its own original home in
 * `MANGOSTUDIO_REAL_HOME`. Bun honours `HOME` only when the process starts, so
 * this preload cannot repair a launcher whose `HOME` did not take effect — it
 * can only refuse to continue, before the first test touches `~/.mango`.
 *
 * Without the variable (a bare `bun test` from `apps/api`) there is nothing to
 * compare against and the check passes; the package scripts are what pin that
 * the lanes go through the launcher (`scripts/tests/api-lanes-hermetic.unit.test.ts`).
 */

import { homedir } from 'node:os';

/** Mirrors `REAL_HOME_ENV` in `scripts/lib/test-home.ts`; workspaces import no relative paths across the repository. */
const REAL_HOME_ENV = 'MANGOSTUDIO_REAL_HOME';

/**
 * Throws when `home` is the launcher's original home.
 *
 * @example
 * assertHermeticHome({ MANGOSTUDIO_REAL_HOME: '/home/me' }, '/tmp/mangostudio-test-home-a1b2c3'); // returns
 * assertHermeticHome({ MANGOSTUDIO_REAL_HOME: '/home/me' }, '/home/me'); // throws
 */
export function assertHermeticHome(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): void {
  const realHome = env[REAL_HOME_ENV]?.trim();
  if (!realHome || home !== realHome) return;
  throw new Error(
    'API test lane is running with the real home directory, so its tests would read and write ' +
      `~/.mango. expected homedir(): a temporary directory like <tmpdir>/mangostudio-test-home-<random> | ` +
      `received: ${JSON.stringify(home)} (the launcher's original home, ${REAL_HOME_ENV}). ` +
      'Start the lane through its package script (`bun run test:unit` / `test:integration` in ' +
      'apps/api), which launches Bun with a temporary HOME; a runtime assignment to ' +
      'process.env.HOME is ignored by Bun.'
  );
}
