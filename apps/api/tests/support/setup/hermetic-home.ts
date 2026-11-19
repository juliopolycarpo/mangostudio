/**
 * Aborts the test lane when it is running with the developer's real home.
 *
 * The lane launcher (`scripts/with-test-home.ts`) starts `bun test` with
 * `HOME` pointing at a temporary directory and records its own original home in
 * `MANGOSTUDIO_REAL_HOME`. Bun honours `HOME` only when the process starts and
 * `os.homedir()` ignores a later `process.env.HOME` assignment, so this preload
 * cannot redirect the home itself (the config layer derives `~/.mango` from
 * `homedir()`, so redirecting `MANGO_HOME` alone would leave the database,
 * logs and config on the real one). It can only refuse to continue, before the
 * first test touches `~/.mango`.
 *
 * A run is accepted when it started under the launcher, or when its `homedir()`
 * already is a `mangostudio-test-home-*` directory (the launcher's shape, for a
 * hand-built wrapper). Anything else is a bare `bun test` on the real home and
 * is refused. `MANGOSTUDIO_TEST_ALLOW_REAL_HOME=1` vouches for a home that is
 * disposable by other means, such as a throwaway CI container.
 */

import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

/** Mirrors `REAL_HOME_ENV` in `scripts/lib/test-home.ts`; workspaces import no relative paths across the repository. */
const REAL_HOME_ENV = 'MANGOSTUDIO_REAL_HOME';

/** Mirrors `TEST_HOME_PREFIX` in `scripts/lib/test-home.ts`. */
const TEST_HOME_PREFIX = 'mangostudio-test-home-';

/** The one value that vouches for a disposable home; any other value is ignored. */
const ALLOW_REAL_HOME_ENV = 'MANGOSTUDIO_TEST_ALLOW_REAL_HOME';

const WRAPPER_ADVICE =
  'Start the lane through its package script (`bun run test:unit` / `test:integration` in ' +
  'apps/api), or for one file run ' +
  '`(cd apps/api && bun ../../scripts/with-test-home.ts bun test <file>)`; both launch Bun with a ' +
  'temporary HOME, and a runtime assignment to process.env.HOME is ignored by Bun. ' +
  `Set ${ALLOW_REAL_HOME_ENV}=1 only when this home is disposable.`;

function homeError(home: string, reason: string): Error {
  return new Error(
    `API test lane is running with the real home directory, so its tests would read and write ~/.mango. ` +
      `expected homedir(): a temporary directory like <tmpdir>/mangostudio-test-home-<random> | ` +
      `received: ${JSON.stringify(home)} (${reason}). ${WRAPPER_ADVICE}`
  );
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * Throws when the lane would use the developer's real home.
 *
 * @example
 * assertHermeticHome({ MANGOSTUDIO_REAL_HOME: '/home/me' }, '/tmp/mangostudio-test-home-a1b2c3'); // returns
 * assertHermeticHome({ MANGOSTUDIO_REAL_HOME: '/home/me' }, '/home/me'); // throws
 * assertHermeticHome({}, '/home/me'); // throws: a bare bun test
 */
export function assertHermeticHome(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): void {
  if (env[ALLOW_REAL_HOME_ENV] === '1') return;

  const realHome = env[REAL_HOME_ENV]?.trim();
  if (!realHome) {
    if (basename(home).startsWith(TEST_HOME_PREFIX)) return;
    throw homeError(
      home,
      `${REAL_HOME_ENV} is unset, so the lane did not start through the launcher`
    );
  }
  if (home === realHome) {
    throw homeError(home, `the launcher's original home, ${REAL_HOME_ENV}`);
  }

  // The runtime home follows MANGO_HOME, so one the developer exported would
  // send a lane with a scratch HOME straight back to the real `~/.mango`.
  const mangoHome = env.MANGO_HOME?.trim();
  if (mangoHome && isInside(resolve(realHome, '.mango'), mangoHome)) {
    throw new Error(
      `API test lane would use the real ~/.mango through MANGO_HOME. ` +
        `expected MANGO_HOME: unset or outside the real home | received: ${JSON.stringify(mangoHome)} ` +
        `(inside ${JSON.stringify(resolve(realHome, '.mango'))}). Unset MANGO_HOME before running the tests.`
    );
  }
}
