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

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Names the temporary home. `playwright.config.ts` is evaluated again in every
 * worker, so the runner publishes the directory it created here and the
 * workers reuse it instead of creating their own.
 */
export const SMOKE_HOME_ENV = 'MANGO_SMOKE_HOME';

/** Prefix of every directory {@link prepareSmokeHome} creates. */
export const SMOKE_HOME_PREFIX = 'mangostudio-smoke-';

/** The machine facts the shape check compares against; injectable for tests. */
export interface SmokeHomeHost {
  /** The OS temporary directory. */
  readonly tmpDir: string;
  /** The developer's real home directory (the parent of `~/.mango`). */
  readonly realHome: string;
}

function currentHost(): SmokeHomeHost {
  return { tmpDir: tmpdir(), realHome: homedir() };
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

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

function findViolation(candidate: string, host: SmokeHomeHost): string | undefined {
  if (!candidate || !isAbsolute(candidate)) return 'not an absolute path';
  const resolved = canonical(candidate);
  const realHome = canonical(host.realHome);
  if (resolved === realHome || isInside(resolved, realHome)) {
    return 'it is, or contains, the real home';
  }
  if (isInside(join(realHome, '.mango'), resolved)) return 'it is inside ~/.mango';
  if (canonical(dirname(resolved)) !== canonical(host.tmpDir)) {
    return 'it is not a direct child of the OS temp directory';
  }
  if (!basename(resolved).startsWith(SMOKE_HOME_PREFIX)) {
    return `its name does not start with ${SMOKE_HOME_PREFIX}`;
  }
  return undefined;
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
  const violation = findViolation(candidate, host);
  if (!violation) return;
  throw new Error(
    `browser-smoke: refusing smoke hub home. expected: ${describeSmokeHomeShape(host)} | ` +
      `received: ${JSON.stringify(candidate)} (${violation}) | real home: ${join(host.realHome, '.mango')}`
  );
}

/**
 * Removes a smoke home, after proving it is one.
 *
 * @example
 * removeSmokeHome('/tmp/mangostudio-smoke-a1b2c3');
 */
export function removeSmokeHome(root: string, host: SmokeHomeHost = currentHost()): void {
  assertTemporarySmokeHome(root, host);
  rmSync(root, { recursive: true, force: true });
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

  const root = mkdtempSync(join(host.tmpDir, SMOKE_HOME_PREFIX));
  assertTemporarySmokeHome(root, host);
  env[SMOKE_HOME_ENV] = root;
  process.on('exit', () => removeSmokeHome(root, host));
  return root;
}

/**
 * The environment that confines a hub to `root`.
 *
 * `HOME`/`USERPROFILE` move the whole home; the explicit storage keys and
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
    HOME: root,
    USERPROFILE: root,
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
    CARGO_HOME: ambient.CARGO_HOME?.trim() || join(host.realHome, '.cargo'),
    RUSTUP_HOME: ambient.RUSTUP_HOME?.trim() || join(host.realHome, '.rustup'),
  };
}
