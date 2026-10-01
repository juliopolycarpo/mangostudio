/**
 * A throwaway home for the hub the browser-smoke suite starts.
 *
 * The suite signs up accounts and creates chats, so the hub it talks to must
 * never be one that keeps its data in the developer's real `~/.mango`. A hub
 * derives every storage location from `homedir()/.mango`
 * (`getHomeMangoDir` in `apps/api/src/lib/config.ts`: database, uploads,
 * images, checkpoints, `run/`, `logs/`, and the `config.toml` and `.env` it
 * reads), so pointing `HOME` at a temporary directory moves all of it at once —
 * the same way the binary smoke in `scripts/test-build.ts` does. `MANGO_HOME`
 * alone would not: it moves only the runtime home.
 *
 * Process environment outranks `config.toml`, so a developer who has exported
 * `DATABASE_PATH` or `MANGO_HOME` in their shell would still escape a bare
 * `HOME` override. {@link smokeHubEnv} therefore pins each of those keys too.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertTemporaryHome,
  createTemporaryHome,
  currentHost,
  homeEnv,
  removeTemporaryHome,
  type TemporaryHomeHost,
  type TemporaryHomeKind,
  toolchainEnv,
} from '../../../scripts/lib/temp-home';

/**
 * Names the temporary home. `playwright.config.ts` is evaluated again in every
 * worker, so the runner publishes the directory it created here and the
 * workers reuse it instead of creating their own.
 */
export const SMOKE_HOME_ENV = 'MANGO_SMOKE_HOME';

/** Prefix of every directory {@link prepareSmokeHome} creates. */
export const SMOKE_HOME_PREFIX = 'mangostudio-smoke-';

/** The address the smoke hub binds: loopback only. */
export const SMOKE_HUB_HOST = '127.0.0.1';

/** The machine facts the shape check compares against; injectable for tests. */
export type SmokeHomeHost = TemporaryHomeHost;

const SMOKE_HOME_KIND: TemporaryHomeKind = {
  prefix: SMOKE_HOME_PREFIX,
  context: 'browser-smoke',
  noun: 'smoke hub home',
};

/**
 * The shape a smoke home must have, for error messages.
 *
 * @example
 * describeSmokeHomeShape({ tmpDir: '/tmp', realHome: '/home/me' });
 * // => '/tmp/mangostudio-smoke-<random>'
 */
export function describeSmokeHomeShape(host: SmokeHomeHost = currentHost()): string {
  return join(host.tmpDir, `${SMOKE_HOME_PREFIX}<random>`);
}

/**
 * Throws unless `candidate` is a fresh-looking temporary smoke home: a direct
 * child of the OS temp directory named `mangostudio-smoke-*`, and never the
 * real home or anything inside it. The same check guards deletion, so a
 * mistaken value can never turn into a recursive delete of a real directory.
 *
 * @example
 * assertTemporarySmokeHome('/tmp/mangostudio-smoke-a1b2c3'); // returns
 * assertTemporarySmokeHome('/home/me/.mango'); // throws, naming the path
 */
export function assertTemporarySmokeHome(
  candidate: string,
  host: SmokeHomeHost = currentHost()
): void {
  assertTemporaryHome(candidate, SMOKE_HOME_KIND, host);
}

/**
 * Removes a smoke home, after proving it is one.
 *
 * @example
 * removeSmokeHome('/tmp/mangostudio-smoke-a1b2c3');
 */
export function removeSmokeHome(root: string, host: SmokeHomeHost = currentHost()): void {
  removeTemporaryHome(root, SMOKE_HOME_KIND, host);
}

/**
 * Returns the temporary home for this run, creating it in the runner process.
 *
 * The first caller creates `<tmp>/mangostudio-smoke-<random>`, publishes it as
 * {@link SMOKE_HOME_ENV}, and removes it when its process exits. Later callers
 * (Playwright workers re-evaluating the config) find the variable and reuse
 * the directory. A value that is not a temporary home — an exported variable
 * pointing at `~/.mango`, say — throws instead of being used.
 *
 * @example
 * const home = prepareSmokeHome(process.env);
 * // => '/tmp/mangostudio-smoke-a1b2c3'
 */
export function prepareSmokeHome(
  env: NodeJS.ProcessEnv = process.env,
  host: SmokeHomeHost = currentHost()
): string {
  const published = env[SMOKE_HOME_ENV]?.trim();
  if (published) {
    assertTemporarySmokeHome(published, host);
    mkdirSync(published, { recursive: true });
    return published;
  }

  const root = createTemporaryHome(SMOKE_HOME_KIND, host);
  env[SMOKE_HOME_ENV] = root;
  process.on('exit', () => removeSmokeHome(root, host));
  return root;
}

/**
 * The environment that confines a hub to `root`.
 *
 * `HOME`/`USERPROFILE` move the whole home; `API_HOST` keeps the hub on
 * loopback; the explicit storage keys and
 * `MANGO_HOME` stop an exported variable from overriding it; the file
 * secret-store keeps connector tokens out of the OS keychain. `CARGO_HOME` and
 * `RUSTUP_HOME` keep the dev server's `cargo build` on the developer's real
 * toolchain, which a moved `HOME` would otherwise hide.
 *
 * @example
 * smokeHubEnv('/tmp/mangostudio-smoke-a1b2c3').DATABASE_PATH;
 * // => '/tmp/mangostudio-smoke-a1b2c3/.mango/database.sqlite'
 */
export function smokeHubEnv(
  root: string,
  ambient: NodeJS.ProcessEnv = process.env,
  host: SmokeHomeHost = currentHost()
): Record<string, string> {
  assertTemporarySmokeHome(root, host);
  const mango = join(root, '.mango');
  return {
    ...homeEnv(root),
    MANGO_HOME: mango,
    DATABASE_PATH: join(mango, 'database.sqlite'),
    UPLOADS_DIR: join(mango, 'uploads'),
    IMAGES_DIR: join(mango, 'images'),
    TOOL_IMAGES_DIR: join(mango, 'tool-images'),
    AGENTS_DIR: join(mango, 'agents'),
    SKILLS_DIR: join(mango, 'skills'),
    CHECKPOINTS_DIR: join(mango, 'checkpoints'),
    MANGO_LIBRARY_BACKUP_DIR: join(mango, 'library-backups'),
    MANGO_SECRET_STORE_UNSAFE_FILE_FALLBACK_DIR: join(root, 'secret-store'),
    // The hub's default bind is every interface, and a fresh home has no
    // config.toml to narrow it. Open signup plus the first-owner Local runtime
    // must never be reachable from the network during a run.
    API_HOST: SMOKE_HUB_HOST,
    ...toolchainEnv(ambient, host),
  };
}
