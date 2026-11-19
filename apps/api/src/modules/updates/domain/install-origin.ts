/**
 * Who installed the running binary, and therefore who may replace it.
 *
 * Three signals, in precedence order: a launcher that announced itself through
 * `MANGOSTUDIO_LAUNCHER` (the npm wrapper and the Cargo launcher both write to the
 * same dist root the shell installer uses, so the path alone cannot tell them
 * apart), the `install-origin.json` the install scripts write at the dist root,
 * and finally the shape of the executable's own path. Pure over an injected
 * probe so every branch is testable without a filesystem.
 */

import {
  INSTALLED_VIA_PATH_MAX,
  type InstalledVia,
  type InstallManager,
  type UpdateChannel,
} from '@mangostudio/shared/updates';

import { resolveRuntimeRelease } from '../../environments/domain/runtime-release-resolution';
import {
  grandparentDirectory,
  hubDistRoot,
  INSTALL_ORIGIN_FILE,
  isUnder,
} from '../../machine/domain/hub-executable';
import { fitToLimit } from '../../machine/domain/machine-limits';

export const LAUNCHER_ENV = 'MANGOSTUDIO_LAUNCHER';
export const LAUNCHER_PATH_ENV = 'MANGOSTUDIO_LAUNCHER_PATH';
export const INSTALL_DIR_ENV = 'MANGOSTUDIO_INSTALL_DIR';

/**
 * The record `install.sh` / `install.ps1` write at the dist root. Read
 * tolerantly: a newer script may add keys this build does not know, and a
 * key it does know may be missing from an older record. Unknown keys are kept
 * on `extra` so nothing is dropped when the record is rewritten.
 */
export interface InstallOriginRecord {
  readonly origin: 'installer' | 'upgrade';
  readonly channel: UpdateChannel;
  readonly version: string;
  readonly previousVersion?: string;
  readonly sourceSha?: string;
  readonly installedAt?: string;
  readonly source?: 'github-release' | 'npm-registry' | 'local-archive';
  /** Where the link (POSIX) or `.cmd` shim (Windows) lives, when not the default. */
  readonly binDir?: string;
  /** Version directories a previous prune could not remove (Windows: a running exe). */
  readonly prunePending?: readonly string[];
}

export interface InstallOriginProbe {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Real path of the running executable, symlinks resolved. */
  readonly execPath: string;
  /** `getVersion()`: `dev` for a source checkout. */
  readonly version: string;
  readonly standalone: boolean;
  readonly container: boolean;
  readonly home: string;
  /** `%LOCALAPPDATA%`; only consulted on win32. */
  readonly localAppData?: string;
  /** UTF-8 contents, or null when absent or unreadable. */
  readonly readFile: (path: string) => string | null;
}

export interface InstallOrigin extends InstalledVia {
  /** Parsed `install-origin.json`, when the dist root has one. */
  readonly record?: InstallOriginRecord;
}

const DEVELOPMENT_VERSION = 'dev';

/** The channel a version string belongs to. // Usage: versionChannel('0.1.1-canary.abc1234') → 'canary' */
export function versionChannel(version: string): UpdateChannel {
  return resolveRuntimeRelease(version, 'linux-x64').channel;
}

function normalizePath(path: string, platform: NodeJS.Platform): string {
  const unified = path.replaceAll('\\', '/');
  return platform === 'win32' ? unified.toLowerCase() : unified;
}

function joinPath(platform: NodeJS.Platform, root: string, name: string): string {
  const separator = platform === 'win32' ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${separator}${name}`;
}

/**
 * Which of the three npm-compatible global installs a wrapper path belongs to.
 * Bun keeps its globals under `.bun/install/global`, pnpm under a `pnpm`
 * segment; anything else is npm itself.
 */
export function npmFamilyFromPath(path: string): 'npm' | 'bun' | 'pnpm' {
  const unified = path.replaceAll('\\', '/').toLowerCase();
  if (unified.includes('/.bun/install/global/')) return 'bun';
  if (/\/pnpm\//.test(unified)) return 'pnpm';
  return 'npm';
}

function isRecordString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Parse the origin record, or null when the text is not one this build can use. */
export function parseInstallOriginRecord(text: string): InstallOriginRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (candidate.origin !== 'installer' && candidate.origin !== 'upgrade') return null;
  if (candidate.channel !== 'stable' && candidate.channel !== 'canary') return null;
  if (!isRecordString(candidate.version)) return null;

  const record: InstallOriginRecord = {
    origin: candidate.origin,
    channel: candidate.channel,
    version: candidate.version,
    ...(isRecordString(candidate.previousVersion)
      ? { previousVersion: candidate.previousVersion }
      : {}),
    ...(isRecordString(candidate.sourceSha) ? { sourceSha: candidate.sourceSha } : {}),
    ...(isRecordString(candidate.installedAt) ? { installedAt: candidate.installedAt } : {}),
    ...(candidate.source === 'github-release' ||
    candidate.source === 'npm-registry' ||
    candidate.source === 'local-archive'
      ? { source: candidate.source }
      : {}),
    ...(isRecordString(candidate.binDir) ? { binDir: candidate.binDir } : {}),
    ...(Array.isArray(candidate.prunePending)
      ? { prunePending: candidate.prunePending.filter(isRecordString) }
      : {}),
  };
  return record;
}

function fromLauncher(probe: InstallOriginProbe, base: InstalledVia): InstallOrigin | null {
  const launcher = probe.env[LAUNCHER_ENV]?.trim().toLowerCase();
  if (!launcher) return null;
  const launcherPath = probe.env[LAUNCHER_PATH_ENV]?.trim();
  const withPath = launcherPath ? { launcherPath } : {};
  if (launcher === 'cargo') return { ...base, manager: 'cargo', ...withPath };
  if (launcher === 'npm') {
    return { ...base, manager: npmFamilyFromPath(launcherPath ?? ''), ...withPath };
  }
  return null;
}

function readOriginRecord(probe: InstallOriginProbe, distRoot: string): InstallOriginRecord | null {
  const text = probe.readFile(joinPath(probe.platform, distRoot, INSTALL_ORIGIN_FILE));
  return text === null ? null : parseInstallOriginRecord(text);
}

/**
 * Roots that may hold this binary without a record: the one the environment
 * names and the platform default. Any other directory only counts as a root
 * when the scripts left `install-origin.json` in it — otherwise every
 * `<vendor>/<version>/mangostudio` layout would read as a legacy install.
 */
function knownDistRoots(probe: InstallOriginProbe): readonly string[] {
  const configured = probe.env[INSTALL_DIR_ENV]?.trim();
  const defaultRoot = hubDistRoot(probe);
  return configured ? [configured, defaultRoot] : [defaultRoot];
}

function fromDistRoot(probe: InstallOriginProbe, base: InstalledVia): InstallOrigin | null {
  for (const distRoot of knownDistRoots(probe)) {
    if (!isUnder(probe.execPath, distRoot, probe.platform)) continue;
    const record = readOriginRecord(probe, distRoot);
    if (record) return { ...base, manager: 'self-managed', distRoot, record };
    return { ...base, manager: 'self-managed', distRoot, legacy: true };
  }
  const distRoot = grandparentDirectory(probe.execPath, probe.platform);
  const record = readOriginRecord(probe, distRoot);
  return record ? { ...base, manager: 'self-managed', distRoot, record } : null;
}

function fromPath(probe: InstallOriginProbe, base: InstalledVia): InstallOrigin {
  const path = normalizePath(probe.execPath, probe.platform).toLowerCase();
  if (path.includes('/cellar/') || path.includes('/homebrew/')) {
    return { ...base, manager: 'homebrew' };
  }
  if (path.includes('/scoop/apps/')) return { ...base, manager: 'scoop' };
  if (path.includes('/node_modules/')) return { ...base, manager: npmFamilyFromPath(path) };
  return { ...base, manager: 'unknown' };
}

/**
 * Detect how this binary was installed. Deployment facts win over launcher
 * markers: a container's `mangostudio` may well sit in a dist root, and a
 * source checkout is never upgradable in place whatever launched it.
 * // Usage: detectInstallOrigin({ platform: 'linux', env: process.env, execPath, version, ... })
 */
export function detectInstallOrigin(probe: InstallOriginProbe): InstallOrigin {
  const base: InstalledVia = {
    manager: 'unknown',
    channel: versionChannel(probe.version),
    executable: probe.execPath,
  };
  if (probe.version === DEVELOPMENT_VERSION || !probe.standalone) {
    return { ...base, manager: 'source' };
  }
  if (probe.container) return { ...base, manager: 'docker' };
  return fromLauncher(probe, base) ?? fromDistRoot(probe, base) ?? fromPath(probe, base);
}

/** What {@link restartLauncher} reads about this machine; every field is injected so the rules stay pure. */
export interface RestartLauncherProbe {
  readonly platform: NodeJS.Platform;
  /** Real path of the running executable, symlinks resolved. */
  readonly execPath: string;
  /** Whether a path exists right now. A launcher the manager did not leave behind is not offered. */
  readonly pathExists: (path: string) => boolean;
}

/**
 * Homebrew relinks `<prefix>/bin/mangostudio` to the new Cellar entry on every
 * upgrade (the formula installs a symlink to `libexec/mangostudio`, so `execve`
 * through it becomes the binary). This process's own path is the Cellar entry
 * of the version that was installed when it started, which `brew cleanup`
 * removes.
 */
function homebrewLauncher(probe: RestartLauncherProbe): string | undefined {
  if (probe.platform === 'win32') return undefined;
  const cellar = /^(.+?)\/Cellar\//.exec(probe.execPath);
  return cellar?.[1] ? `${cellar[1]}/bin/mangostudio` : undefined;
}

/**
 * pnpm keeps each version under `<pnpm home>/global/<n>/…/.pnpm/mangostudio@<version>`
 * and repoints the shim in `<pnpm home>` itself on upgrade. POSIX only: the
 * Windows shim is a `.cmd` that `CreateProcess` cannot start with the restart's
 * argv, and the Windows delegate comes back through PATH in its waiter instead.
 */
function pnpmLauncher(probe: RestartLauncherProbe): string | undefined {
  if (probe.platform === 'win32') return undefined;
  const home = /^(.+)\/global\/[^/]+\/(?:node_modules|\.pnpm)\//.exec(probe.execPath);
  return home?.[1] ? `${home[1]}/mangostudio` : undefined;
}

/**
 * Scoop installs into `apps\<app>\<version>` and repoints the `current`
 * junction on upgrade. The shim in `scoop\shims` supervises the binary as a
 * child; the junction's own `.exe` is the binary.
 */
function scoopLauncher(probe: RestartLauncherProbe): string | undefined {
  if (probe.platform !== 'win32') return undefined;
  const versioned = /^(.*[\\/]scoop[\\/]apps[\\/][^\\/]+)[\\/][^\\/]+[\\/]([^\\/]+)$/i.exec(
    probe.execPath
  );
  return versioned?.[1] && versioned[2] ? `${versioned[1]}\\current\\${versioned[2]}` : undefined;
}

/**
 * The path a restart after a delegated upgrade re-execs, when it is not this
 * process's own. That path names the build the manager just replaced for
 * every manager that puts the version in it (pnpm, Homebrew, Scoop), and may
 * be gone. Each manager leaves a path that follows its upgrade, resolved here
 * from the layout without running the manager:
 *
 * - cargo: the shim that announced itself through `MANGOSTUDIO_LAUNCHER_PATH`.
 * - Homebrew: `<prefix>/bin/mangostudio`, a symlink to the current Cellar entry.
 * - pnpm (POSIX): the shim in the pnpm home.
 * - Scoop: `apps\mangostudio\current\mangostudio.exe`.
 *
 * npm and bun are absent on purpose: their platform package's path has no
 * version, so re-execing `process.execPath` already lands on the new build,
 * and the npm wrapper is a `.js` file a restart cannot start directly.
 *
 * Some of these launchers supervise the binary as a child process instead of
 * becoming it (the pnpm shim, the Windows cargo shim), so the pid a restart
 * spawns is not the pid the hub writes to its state file. `confirmStarted` in
 * `cli/detach.ts` accepts a successor instead of requiring that pid. See #1024.
 * // Usage: restartLauncher(detectInstallOrigin(probe), { platform, execPath, pathExists })
 */
export function restartLauncher(
  via: Pick<InstalledVia, 'manager' | 'launcherPath'>,
  probe: RestartLauncherProbe
): string | undefined {
  if (via.manager === 'cargo') return via.launcherPath;
  const launcher = derivedLauncher(via.manager, probe);
  return launcher !== undefined && probe.pathExists(launcher) ? launcher : undefined;
}

function derivedLauncher(manager: InstallManager, probe: RestartLauncherProbe): string | undefined {
  switch (manager) {
    case 'homebrew':
      return homebrewLauncher(probe);
    case 'pnpm':
      return pnpmLauncher(probe);
    case 'scoop':
      return scoopLauncher(probe);
    default:
      return undefined;
  }
}

/**
 * The launcher a versioned executable path belongs to, whichever manager laid
 * it out. A service unit written before it named the launcher records the
 * versioned path and nothing about its manager, so the layout is all there is
 * to go on. Unlike {@link restartLauncher} it does not require the executable
 * to exist: the manager may already have removed that version.
 * // Usage: launcherForVersionedPath('/opt/homebrew/Cellar/mangostudio/0.1.1/libexec/mangostudio', probe) → '/opt/homebrew/bin/mangostudio'
 */
export function launcherForVersionedPath(
  executable: string,
  probe: Pick<RestartLauncherProbe, 'platform' | 'pathExists'>
): string | undefined {
  const layout: RestartLauncherProbe = { ...probe, execPath: executable };
  for (const manager of ['homebrew', 'pnpm', 'scoop'] as const) {
    const launcher = derivedLauncher(manager, layout);
    if (launcher !== undefined && probe.pathExists(launcher)) return launcher;
  }
  return undefined;
}

/**
 * `InstalledVia` cut to the wire caps — a launcher path or dist root can be
 * arbitrarily long. Shared by the machine API's `GET /machine/update` and
 * the upgrade engine's report, so the two surfaces cannot disagree about how
 * much of a path survives onto the wire.
 * // Usage: fitInstalledVia(installedVia)
 */
export function fitInstalledVia(via: InstalledVia): InstalledVia {
  return {
    manager: via.manager,
    channel: via.channel,
    executable: fitToLimit(via.executable, INSTALLED_VIA_PATH_MAX),
    ...(via.distRoot !== undefined
      ? { distRoot: fitToLimit(via.distRoot, INSTALLED_VIA_PATH_MAX) }
      : {}),
    ...(via.legacy !== undefined ? { legacy: via.legacy } : {}),
    ...(via.launcherPath !== undefined
      ? { launcherPath: fitToLimit(via.launcherPath, INSTALLED_VIA_PATH_MAX) }
      : {}),
  };
}

/** Wording for `doctor`, `status` and the CLI. // Usage: describeInstallManager('bun') → 'npm (bun global)' */
export function describeInstallManager(manager: InstallManager): string {
  switch (manager) {
    case 'self-managed':
      return 'install script';
    case 'npm':
      return 'npm';
    case 'bun':
      return 'npm (bun global)';
    case 'pnpm':
      return 'npm (pnpm global)';
    case 'homebrew':
      return 'Homebrew';
    case 'scoop':
      return 'Scoop';
    case 'cargo':
      return 'Cargo';
    case 'docker':
      return 'Docker image';
    case 'source':
      return 'source checkout';
    case 'unknown':
      return 'unknown';
  }
}
