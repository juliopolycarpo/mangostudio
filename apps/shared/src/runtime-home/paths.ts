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
 */

import { posix, win32 } from 'node:path';
import type { RuntimeSlot } from './schemas';

export const MANGO_HOME_DIR_NAME = '.mango';
export const RUNTIME_HOME_DIR_NAME = 'runtime';
export const RUNTIME_CURRENT_LINK_NAME = 'current';
export const RUNTIME_CONFIG_FILE_NAME = 'runtime.json';
export const RUNTIME_CREDENTIALS_FILE_NAME = 'credentials.json';
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

function pathFor(options: RuntimeHomeOptions) {
  return options.platform === 'win32' ? win32 : posix;
}

/** `<home>/.mango`. Takes the home directory so this stays free of `node:os`. */
export function mangoHomeDir(home: string, platform?: string): string {
  return (platform === 'win32' ? win32 : posix).join(home, MANGO_HOME_DIR_NAME);
}

export function runtimeHomeDir(options: RuntimeHomeOptions): string {
  return pathFor(options).join(options.mangoHome, RUNTIME_HOME_DIR_NAME);
}

export function runtimeSlotDir(slot: RuntimeSlot, options: RuntimeHomeOptions): string {
  return pathFor(options).join(runtimeHomeDir(options), slot);
}

export function runtimeSlotConfigPath(slot: RuntimeSlot, options: RuntimeHomeOptions): string {
  return pathFor(options).join(runtimeSlotDir(slot, options), RUNTIME_CONFIG_FILE_NAME);
}

export function runtimeSlotCredentialsPath(slot: RuntimeSlot, options: RuntimeHomeOptions): string {
  return pathFor(options).join(runtimeSlotDir(slot, options), RUNTIME_CREDENTIALS_FILE_NAME);
}

/** The link a launcher points at, which survives every upgrade. */
export function runtimeSlotCurrentDir(slot: RuntimeSlot, options: RuntimeHomeOptions): string {
  return pathFor(options).join(runtimeSlotDir(slot, options), RUNTIME_CURRENT_LINK_NAME);
}

/** Where an install writes bytes before publishing them through `current`. */
export function runtimeSlotVersionDir(
  slot: RuntimeSlot,
  version: string,
  options: RuntimeHomeOptions
): string {
  return pathFor(options).join(runtimeSlotDir(slot, options), version);
}

export function runtimeBinaryName(platform?: string): string {
  return platform === 'win32' ? `${RUNTIME_BINARY_BASENAME}.exe` : RUNTIME_BINARY_BASENAME;
}

export function runtimeSlotCurrentBinaryPath(
  slot: RuntimeSlot,
  options: RuntimeHomeOptions
): string {
  return pathFor(options).join(
    runtimeSlotCurrentDir(slot, options),
    runtimeBinaryName(options.platform)
  );
}

export function runtimeSlotVersionBinaryPath(
  slot: RuntimeSlot,
  version: string,
  options: RuntimeHomeOptions
): string {
  return pathFor(options).join(
    runtimeSlotVersionDir(slot, version, options),
    runtimeBinaryName(options.platform)
  );
}

/**
 * Which slot a path belongs to, or null when it is outside the home entirely.
 *
 * A runtime has to answer this about its own executable: the same binary serves
 * a `host` install and an ssh-pushed `remote` one, and only its location says
 * which consent file governs it. Comparison is case-sensitive and separator
 * normalised, and a prefix match must land on a boundary — `…/runtime/remotely`
 * is not the `remote` slot.
 */
export function runtimeSlotForPath(path: string, options: RuntimeHomeOptions): RuntimeSlot | null {
  const separator = pathFor(options).sep;
  const normalize = (value: string): string =>
    value.replaceAll(options.platform === 'win32' ? '/' : '\\', separator).replace(/[\\/]+$/, '');
  const candidate = normalize(path);

  for (const slot of ['host', 'wsl', 'remote'] as const) {
    const root = normalize(runtimeSlotDir(slot, options));
    if (candidate === root || candidate.startsWith(`${root}${separator}`)) return slot;
  }
  return null;
}
