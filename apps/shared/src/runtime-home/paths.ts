/**
 * Where everything in the runtime home lives.
 *
 * Config at the slot root, binaries under `<version>/`, so an upgrade replaces
 * bytes and never consent. Between them sits `current`, a symlink the installer
 * swaps: it exists so that an ssh launch argument and a service unit's
 * `ExecStart` can be written once and keep working after an upgrade, instead of
 * embedding a version that dangles the moment one lands.
 *
 * Pure string work — the callers that touch disk live in the runtime and the
 * hub. A Windows hub builds paths *inside a Linux distribution* here, so the
 * flavour is a parameter rather than this module's own platform.
 *
 * Deliberately free of `node:path`. This module is reachable from the
 * `environments` barrel, so it ships in the frontend bundle, and Vite resolves
 * a node builtin there to a stub rather than failing the build: the first
 * module-level `posix.join` then throws on `undefined` and the whole app
 * renders nothing while every other gate stays green. Joining for a named
 * platform is a separator and no filesystem, so owning it costs less than the
 * import did.
 */

import { RUNTIME_SLOTS, type RuntimeSlot } from './schemas';

export const MANGO_HOME_DIR_NAME = '.mango';
export const RUNTIME_HOME_DIR_NAME = 'runtime';
export const RUNTIME_CURRENT_LINK_NAME = 'current';
export const RUNTIME_CONFIG_FILE_NAME = 'runtime.json';
export const RUNTIME_CREDENTIALS_FILE_NAME = 'credentials.json';
/**
 * The lock every writer of `runtime.json` takes, named here because a second
 * workspace depends on it: a hub provisioning a WSL distribution writes that
 * file from outside the runtime, and has to take the same lock the runtime's
 * own writers do or it is not a lock.
 */
export const RUNTIME_CONFIG_LOCK_FILE_NAME = 'runtime.lock';
export const RUNTIME_BINARY_BASENAME = 'mangostudio-runtime';

export interface RuntimeHomeOptions {
  /** Absolute `~/.mango` on the machine that holds the slot. */
  readonly mangoHome: string;
  /**
   * Platform of that machine, which decides the separator and the executable
   * suffix. Defaults to posix: `wsl` and `remote` slots are Linux or macOS by
   * definition this cycle, and only a `host` slot is ever win32.
   */
  readonly platform?: string;
}

/** Windows treats both as separators; posix has only one, and `\` is a name. */
function separatorFor(platform?: string): string {
  return platform === 'win32' ? '\\' : '/';
}

/**
 * Drops the separators a path ends with, walking back from the end.
 *
 * A loop rather than `/\/+$/`, which backtracks quadratically on a long run of
 * separators — these strings come out of a config file and an executable path,
 * so the input is not this module's to vouch for.
 */
function trimTrailingSeparators(value: string, windows: boolean): string {
  let end = value.length;
  while (end > 0) {
    const character = value[end - 1];
    if (character !== '/' && !(windows && character === '\\')) break;
    end -= 1;
  }
  return value.slice(0, end);
}

/**
 * Joins segments for the target platform, the way that platform spells paths.
 *
 * Only trailing separators are trimmed, and only the ones the target actually
 * recognises — the rest of each segment is left exactly as given, because a
 * name is the one thing this must never rewrite.
 */
function joinFor(platform: string | undefined, ...segments: readonly string[]): string {
  const windows = platform === 'win32';
  const separator = separatorFor(platform);
  const joined = segments.reduce((left, right) => {
    if (!left) return right;
    if (!right) return left;
    return `${trimTrailingSeparators(left, windows)}${separator}${right}`;
  }, '');
  return windows ? joined.replaceAll('/', separator) : joined;
}

/** `<home>/.mango`. Takes the home directory so this stays free of `node:os`. */
export function mangoHomeDir(home: string, platform?: string): string {
  return joinFor(platform, home, MANGO_HOME_DIR_NAME);
}

export function runtimeHomeDir(options: RuntimeHomeOptions): string {
  return joinFor(options.platform, options.mangoHome, RUNTIME_HOME_DIR_NAME);
}

export function runtimeSlotDir(slot: RuntimeSlot, options: RuntimeHomeOptions): string {
  return joinFor(options.platform, runtimeHomeDir(options), slot);
}

export function runtimeSlotConfigPath(slot: RuntimeSlot, options: RuntimeHomeOptions): string {
  return joinFor(options.platform, runtimeSlotDir(slot, options), RUNTIME_CONFIG_FILE_NAME);
}

export function runtimeSlotCredentialsPath(slot: RuntimeSlot, options: RuntimeHomeOptions): string {
  return joinFor(options.platform, runtimeSlotDir(slot, options), RUNTIME_CREDENTIALS_FILE_NAME);
}

/** The link a launcher points at, which survives every upgrade. */
export function runtimeSlotCurrentDir(slot: RuntimeSlot, options: RuntimeHomeOptions): string {
  return joinFor(options.platform, runtimeSlotDir(slot, options), RUNTIME_CURRENT_LINK_NAME);
}

/** Where an install writes bytes before publishing them through `current`. */
export function runtimeSlotVersionDir(
  slot: RuntimeSlot,
  version: string,
  options: RuntimeHomeOptions
): string {
  return joinFor(options.platform, runtimeSlotDir(slot, options), version);
}

export function runtimeBinaryName(platform?: string): string {
  return platform === 'win32' ? `${RUNTIME_BINARY_BASENAME}.exe` : RUNTIME_BINARY_BASENAME;
}

export function runtimeSlotCurrentBinaryPath(
  slot: RuntimeSlot,
  options: RuntimeHomeOptions
): string {
  return joinFor(
    options.platform,
    runtimeSlotCurrentDir(slot, options),
    runtimeBinaryName(options.platform)
  );
}

export function runtimeSlotVersionBinaryPath(
  slot: RuntimeSlot,
  version: string,
  options: RuntimeHomeOptions
): string {
  return joinFor(
    options.platform,
    runtimeSlotVersionDir(slot, version, options),
    runtimeBinaryName(options.platform)
  );
}

/**
 * Which slot a path belongs to, or null when it is outside the home entirely.
 *
 * A runtime has to answer this about its own executable: the same binary serves
 * a `host` install and an ssh-pushed `remote` one, and only its location says
 * which consent file governs it. A prefix match must land on a boundary —
 * `…/runtime/remotely` is not the `remote` slot.
 *
 * Comparison follows the target's own rules rather than one set for both.
 * Windows accepts either separator and matches without regard to case, so a
 * binary reported as `C:\USERS\…` has to find the config that governs it. Posix
 * does neither: there, `\` is an ordinary character in a file's name, and
 * treating it as a separator would place `…/runtime/host\x` — a file outside
 * every slot — under `host`, which is the slot that means full consent.
 */
export function runtimeSlotForPath(path: string, options: RuntimeHomeOptions): RuntimeSlot | null {
  const windows = options.platform === 'win32';
  const separator = separatorFor(options.platform);
  const normalize = (value: string): string => {
    const spelled = windows ? value.replaceAll('/', separator) : value;
    const trimmed = trimTrailingSeparators(spelled, windows);
    return windows ? trimmed.toLowerCase() : trimmed;
  };
  const candidate = normalize(path);

  for (const slot of RUNTIME_SLOTS) {
    const root = normalize(runtimeSlotDir(slot, options));
    if (candidate === root || candidate.startsWith(`${root}${separator}`)) return slot;
  }
  return null;
}
