/**
 * Throwaway home directories for processes that must never see the developer's
 * real one: the browser-smoke hub and the API test lanes.
 *
 * Everything the hub and its tests derive from `homedir()` (`~/.mango`,
 * `~/.claude`, `~/.cache`, ...) moves with `HOME` — and `USERPROFILE` on
 * Windows — but only when the variable is set when the process STARTS: Bun
 * ignores a runtime assignment to `process.env.HOME`. So the home has to be
 * chosen by whatever spawns the process, which is what these helpers are for.
 *
 * The same guard protects creation, reuse and deletion: a home is only ever a
 * direct child of the OS temp directory with the caller's name prefix, and
 * never the real home or anything inside it, so a mistaken value can never turn
 * into a recursive delete of a real directory.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Names one kind of temporary home: how it is spelled on disk and in errors. */
export interface TemporaryHomeKind {
  /** Prefix of every directory created, e.g. `mangostudio-smoke-`. */
  readonly prefix: string;
  /** Leads every refusal, e.g. `browser-smoke`. */
  readonly context: string;
  /** What the refused path was meant to be, e.g. `smoke hub home`. */
  readonly noun: string;
}

/** The machine facts the shape check compares against; injectable for tests. */
export interface TemporaryHomeHost {
  /** The OS temporary directory. */
  readonly tmpDir: string;
  /** The developer's real home directory (the parent of `~/.mango`). */
  readonly realHome: string;
}

/** The host this process runs on. */
export function currentHost(): TemporaryHomeHost {
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
 * The shape a temporary home must have, for error messages.
 *
 * @example
 * describeTemporaryHomeShape({ prefix: 'mangostudio-smoke-', context: 'x', noun: 'y' },
 *   { tmpDir: '/tmp', realHome: '/home/me' });
 * // => '/tmp/mangostudio-smoke-<random>'
 */
function describeTemporaryHomeShape(
  kind: TemporaryHomeKind,
  host: TemporaryHomeHost = currentHost()
): string {
  return join(host.tmpDir, `${kind.prefix}<random>`);
}

function findViolation(
  candidate: string,
  kind: TemporaryHomeKind,
  host: TemporaryHomeHost
): string | undefined {
  if (!candidate || !isAbsolute(candidate)) return 'not an absolute path';
  // The check resolves `..` lexically, but the OS resolves it after following
  // symlinks, so a `..` could name a different directory than the one proved.
  if (candidate.split(/[\\/]/).includes('..')) return 'it contains ".." segments';
  const resolved = canonical(candidate);
  const realHome = canonical(host.realHome);
  if (resolved === realHome || isInside(resolved, realHome)) {
    return 'it is, or contains, the real home';
  }
  if (isInside(join(realHome, '.mango'), resolved)) return 'it is inside ~/.mango';
  if (canonical(dirname(resolved)) !== canonical(host.tmpDir)) {
    return 'it is not a direct child of the OS temp directory';
  }
  if (!basename(resolved).startsWith(kind.prefix)) {
    return `its name does not start with ${kind.prefix}`;
  }
  return undefined;
}

/**
 * Throws unless `candidate` is a temporary home of `kind`: a direct child of
 * the OS temp directory named `<prefix>*`, and never the real home or anything
 * inside it. The same check guards deletion.
 *
 * @example
 * assertTemporaryHome('/tmp/mangostudio-smoke-a1b2c3', kind); // returns
 * assertTemporaryHome('/home/me/.mango', kind); // throws, naming the path
 */
export function assertTemporaryHome(
  candidate: string,
  kind: TemporaryHomeKind,
  host: TemporaryHomeHost = currentHost()
): void {
  const violation = findViolation(candidate, kind, host);
  if (!violation) return;
  throw new Error(
    `${kind.context}: refusing ${kind.noun}. expected: ${describeTemporaryHomeShape(kind, host)} | ` +
      `received: ${JSON.stringify(candidate)} (${violation}) | real home: ${join(host.realHome, '.mango')}`
  );
}

/**
 * Creates `<tmpdir>/<prefix><random>` and proves it has the right shape.
 *
 * @example
 * const root = createTemporaryHome(kind);
 * // => '/tmp/mangostudio-smoke-a1b2c3'
 */
export function createTemporaryHome(
  kind: TemporaryHomeKind,
  host: TemporaryHomeHost = currentHost()
): string {
  const root = mkdtempSync(join(host.tmpDir, kind.prefix));
  assertTemporaryHome(root, kind, host);
  return root;
}

/**
 * Removes a temporary home, after proving it is one.
 *
 * @example
 * removeTemporaryHome('/tmp/mangostudio-smoke-a1b2c3', kind);
 */
export function removeTemporaryHome(
  root: string,
  kind: TemporaryHomeKind,
  host: TemporaryHomeHost = currentHost()
): void {
  assertTemporaryHome(root, kind, host);
  // Delete the path that was checked, not the spelling it was given in.
  rmSync(canonical(root), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * The variables that make a process started with them see `root` as its home.
 *
 * @example
 * homeEnv('/tmp/mangostudio-smoke-a1b2c3').HOME; // => '/tmp/mangostudio-smoke-a1b2c3'
 */
export function homeEnv(root: string): Record<string, string> {
  return { HOME: root, USERPROFILE: root };
}

/**
 * The toolchain homes a moved `HOME` would otherwise hide, pinned to the real
 * ones unless the developer already exported another location. Each default is
 * what its tool would have derived from the real home.
 *
 * @example
 * toolchainEnv({}, { tmpDir: '/tmp', realHome: '/home/me' }).CARGO_HOME;
 * // => '/home/me/.cargo'
 */
export function toolchainEnv(
  ambient: NodeJS.ProcessEnv,
  host: TemporaryHomeHost = currentHost()
): Record<string, string> {
  return {
    CARGO_HOME: ambient.CARGO_HOME?.trim() || join(host.realHome, '.cargo'),
    RUSTUP_HOME: ambient.RUSTUP_HOME?.trim() || join(host.realHome, '.rustup'),
  };
}
