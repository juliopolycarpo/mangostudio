/**
 * What a service unit should run to start this hub. The answer depends on how
 * the binary got here: an installer layout has a `current` pointer that
 * survives upgrades, a package manager keeps its own path stable, and a source
 * checkout runs through Bun.
 */

import { posix, win32 } from 'node:path';

/** Path joining that follows the probed platform, not the one running the probe. */
function joiner(platform: NodeJS.Platform): typeof posix.join {
  return platform === 'win32' ? win32.join : posix.join;
}

export type HubExecutablePointer = 'current' | 'versioned' | 'external' | 'source';

export interface HubExecutableProbe {
  readonly platform: NodeJS.Platform;
  readonly standalone: boolean;
  /** Real path of the running executable (symlinks resolved). */
  readonly execPath: string;
  /** Entry module when not standalone, i.e. `Bun.main`. */
  readonly entryPath: string;
  readonly cwd: string;
  readonly home: string;
  /** `%LOCALAPPDATA%`; only consulted on win32. */
  readonly localAppData?: string;
  readonly pathExists: (path: string) => boolean;
}

export interface HubExecutable {
  /** Program first, then the arguments that precede `serve`. */
  readonly argv: readonly string[];
  readonly workingDirectory?: string;
  readonly pointer: HubExecutablePointer;
  /** Why the unit points where it does, when that is worth telling the user. */
  readonly note?: string;
}

/** Root of the installer's side-by-side version directories. */
export function hubDistRoot(probe: Pick<HubExecutableProbe, 'platform' | 'home' | 'localAppData'>) {
  const join = joiner(probe.platform);
  if (probe.platform === 'win32') {
    return join(probe.localAppData ?? join(probe.home, 'AppData', 'Local'), 'mangostudio');
  }
  return join(probe.home, '.mango', 'dist');
}

export const INSTALL_ORIGIN_FILE = 'install-origin.json';

/**
 * The directory two levels above the executable: `<root>/<version>/mangostudio`
 * puts the root there. Platform-aware, since the probe may describe a Windows
 * path on a POSIX host.
 */
export function grandparentDirectory(execPath: string, platform: NodeJS.Platform): string {
  const path = platform === 'win32' ? win32 : posix;
  return path.dirname(path.dirname(execPath));
}

/**
 * The dist root holding this executable. Normally the default root, but the
 * install scripts honour `MANGOSTUDIO_INSTALL_DIR`, so a binary may live under
 * any root — recognised by the `install-origin.json` the scripts leave two
 * levels above it. // Usage: hubDistRootFor(probe)
 */
export function hubDistRootFor(
  probe: Pick<HubExecutableProbe, 'platform' | 'home' | 'localAppData' | 'execPath' | 'pathExists'>
): string {
  const candidate = grandparentDirectory(probe.execPath, probe.platform);
  const join = joiner(probe.platform);
  if (probe.pathExists(join(candidate, INSTALL_ORIGIN_FILE))) return candidate;
  return hubDistRoot(probe);
}

/** The launcher the installer maintains across upgrades. */
export function hubCurrentPointerPath(
  probe: Pick<HubExecutableProbe, 'platform' | 'home' | 'localAppData'> &
    Partial<Pick<HubExecutableProbe, 'execPath' | 'pathExists'>>
): string {
  const root =
    probe.execPath !== undefined && probe.pathExists !== undefined
      ? hubDistRootFor({ ...probe, execPath: probe.execPath, pathExists: probe.pathExists })
      : hubDistRoot(probe);
  const join = joiner(probe.platform);
  return probe.platform === 'win32'
    ? join(root, 'bin', 'mangostudio.cmd')
    : join(root, 'current', 'mangostudio');
}

function isUnder(path: string, root: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) => {
    const unified = value.replaceAll('\\', '/');
    return platform === 'win32' ? unified.toLowerCase() : unified;
  };
  const prefix = normalize(root).replace(/\/+$/, '');
  return normalize(path).startsWith(`${prefix}/`);
}

/** Decide what the unit runs. // Usage: resolveHubExecutable(probe) */
export function resolveHubExecutable(probe: HubExecutableProbe): HubExecutable {
  if (!probe.standalone) {
    return {
      argv: [probe.execPath, probe.entryPath],
      workingDirectory: probe.cwd,
      pointer: 'source',
      note: `Source checkout: the unit runs ${probe.entryPath} through ${probe.execPath}.`,
    };
  }

  const root = hubDistRootFor(probe);
  if (!isUnder(probe.execPath, root, probe.platform)) {
    return { argv: [probe.execPath], pointer: 'external' };
  }

  const pointer = hubCurrentPointerPath(probe);
  if (probe.pathExists(pointer)) {
    return { argv: [pointer], pointer: 'current' };
  }
  return {
    argv: [probe.execPath],
    pointer: 'versioned',
    note: `No launcher at ${pointer}; the unit names this version's directory and needs "mangostudio service install" again after an upgrade.`,
  };
}
