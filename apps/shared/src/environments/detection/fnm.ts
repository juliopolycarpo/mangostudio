import { posix, win32 } from 'node:path';
import type { PathEnv } from '../../runtime-env';
import type { ManagedVersion, VersionManagerStatus } from '../schemas';
import { windowsDefaultFnmDir } from './binary-scan';
import type { NodeReleaseSchedule } from './lts-policy';
import {
  createManagedVersionFindings,
  findCurrentVersion,
  listOptionalDirectory,
  type ManagedVersionFileSystem,
  preferNewerVersion,
  sortVersionsDescending,
  toManagedVersions,
} from './version-manager-support';

/** fnm never reads a file as text — its aliases are symlinks, not `nvm.sh`-style scripts. */
export type FnmFileSystem = ManagedVersionFileSystem;

export interface FnmDetectionOptions {
  readonly now: Date;
  readonly schedule: NodeReleaseSchedule;
  readonly currentNodePath?: string;
  readonly latestByMajor?: ReadonlyMap<number, string>;
  readonly liveDataAvailable?: boolean;
  /**
   * `fnm --version` output, already parsed to `major.minor.patch`. Reused
   * from the runtime's own fnm scan — the same one `probeRuntimes` runs —
   * rather than spawning `fnm --version` a second time here.
   */
  readonly managerVersion?: string;
}

export interface FnmDetectionDeps extends Pick<PathEnv, 'platform' | 'homeDir' | 'env'> {
  readonly fs: FnmFileSystem;
}

const VERSION_DIRECTORY_PATTERN = /^v?(\d+\.\d+\.\d+)$/;

/**
 * The version segment fnm encodes in an alias's resolved target, e.g.
 * `.../node-versions/v24.18.0/installation` (POSIX) or
 * `...\node-versions\v24.18.0\installation` (Windows, matched after
 * backslash normalization). Not anchored to an `/installation` suffix: a
 * layout that resolves an alias straight to the version directory should
 * still read, rather than silently losing the default.
 */
const ALIAS_TARGET_VERSION_PATTERN = /node-versions\/v?(\d+\.\d+\.\d+)(?:\/|$)/;

function pathApi(platform: string): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix;
}

function nodeBinaryPath(root: string, versionDir: string, platform: string): string {
  const api = pathApi(platform);
  return platform === 'win32'
    ? api.join(root, 'node-versions', versionDir, 'installation', 'node.exe')
    : api.join(root, 'node-versions', versionDir, 'installation', 'bin', 'node');
}

/**
 * `FNM_DIR` first, then the platform default, then `~/.fnm` — fnm's own
 * pre-XDG layout — as a legacy fallback. Each candidate has to actually be on
 * disk: an `FNM_DIR` pointing nowhere must not shadow a real install sitting
 * at the platform default.
 */
async function resolveFnmRoot(deps: FnmDetectionDeps): Promise<string | undefined> {
  for (const root of fnmRootCandidates(deps)) {
    if (await deps.fs.pathExists(root)) return root;
  }
  return undefined;
}

/**
 * Every directory fnm may call its root, most specific first: `FNM_DIR`, the
 * platform default (`%APPDATA%\fnm`, `~/Library/Application Support/fnm` on
 * macOS, `~/.local/share/fnm` elsewhere), then the pre-XDG `~/.fnm`. One list
 * for the detector, the well-known Node dirs and the spawn-env builder, so no
 * two of them can disagree about where fnm lives on a platform.
 * // Usage: fnmRootCandidates({ platform: 'darwin', homeDir: '/Users/a', env: {} })
 */
export function fnmRootCandidates(env: Pick<PathEnv, 'platform' | 'homeDir' | 'env'>): string[] {
  const api = pathApi(env.platform);
  const configuredRoot = env.env.FNM_DIR?.trim();
  const platformDefault =
    env.platform === 'win32'
      ? windowsDefaultFnmDir(env)
      : env.platform === 'darwin'
        ? api.join(env.homeDir, 'Library', 'Application Support', 'fnm')
        : api.join(env.homeDir, '.local', 'share', 'fnm');
  const legacyRoot = env.platform === 'win32' ? undefined : api.join(env.homeDir, '.fnm');

  return [configuredRoot, platformDefault, legacyRoot].filter(
    (candidate, index, roots): candidate is string =>
      Boolean(candidate?.trim()) && roots.indexOf(candidate) === index
  );
}

/** The directory fnm's `default` alias exposes a `node` binary in, under `root`. */
export function fnmDefaultAliasBinDir(platform: string, root: string): string {
  return platform === 'win32'
    ? win32.join(root, 'aliases', 'default')
    : posix.join(root, 'aliases', 'default', 'bin');
}

async function readInstalledVersions(
  root: string,
  deps: FnmDetectionDeps
): Promise<Array<{ version: string; path: string }>> {
  const versionsRoot = pathApi(deps.platform).join(root, 'node-versions');
  const versions: Array<{ version: string; path: string }> = [];

  for (const entry of await listOptionalDirectory(deps.fs, versionsRoot)) {
    const match = VERSION_DIRECTORY_PATTERN.exec(entry);
    if (!match) continue;
    const nodePath = nodeBinaryPath(root, entry, deps.platform);
    if (!(await deps.fs.pathExists(nodePath))) continue;

    let resolvedPath = nodePath;
    try {
      resolvedPath = await deps.fs.realpath(nodePath);
    } catch {
      // The binary exists, so retain its stable layout path when realpath fails.
    }
    versions.push({ version: match[1] as string, path: resolvedPath });
  }

  return sortVersionsDescending(versions);
}

/**
 * fnm's `default` alias is a symlink (junction on Windows) straight to a
 * version's installation directory — there is no separate alias-name layer
 * the way nvm's `alias/default` file can hold `lts/*`, so the resolved
 * version doubles as the alias itself.
 */
async function resolveDefaultVersion(
  root: string,
  deps: FnmDetectionDeps
): Promise<string | undefined> {
  const aliasPath = pathApi(deps.platform).join(root, 'aliases', 'default');
  if (!(await deps.fs.pathExists(aliasPath))) return undefined;

  let resolved: string;
  try {
    resolved = await deps.fs.realpath(aliasPath);
  } catch {
    return undefined;
  }
  const match = ALIAS_TARGET_VERSION_PATTERN.exec(resolved.replaceAll('\\', '/'));
  return match ? (match[1] as string) : undefined;
}

export async function detectFnm(
  deps: FnmDetectionDeps,
  options: FnmDetectionOptions
): Promise<VersionManagerStatus> {
  const root = await resolveFnmRoot(deps);
  if (!root) {
    return {
      id: 'fnm',
      installed: false,
      versions: [],
      findings: [{ code: 'not-found', params: { manager: 'fnm' } }],
    };
  }

  const [defaultVersion, installedVersions] = await Promise.all([
    resolveDefaultVersion(root, deps),
    readInstalledVersions(root, deps),
  ]);

  const latestByMajor = new Map<number, string>();
  for (const version of installedVersions) preferNewerVersion(latestByMajor, version.version);
  for (const version of options.latestByMajor?.values() ?? []) {
    preferNewerVersion(latestByMajor, version);
  }

  const currentVersion = findCurrentVersion(
    installedVersions,
    options.currentNodePath,
    deps.platform
  );
  const versions: ManagedVersion[] = toManagedVersions(installedVersions, {
    schedule: options.schedule,
    now: options.now,
    latestByMajor,
    liveDataAvailable: options.liveDataAvailable,
    defaultVersion,
    currentVersion,
  });

  return {
    id: 'fnm',
    installed: true,
    root,
    ...(options.managerVersion !== undefined && { managerVersion: options.managerVersion }),
    versions,
    // The alias and the version it resolves to are always the same string —
    // see `resolveDefaultVersion`.
    ...(defaultVersion !== undefined && { defaultAlias: defaultVersion, defaultVersion }),
    ...(currentVersion !== undefined && { currentVersion }),
    findings: createManagedVersionFindings(
      'fnm',
      defaultVersion,
      defaultVersion,
      currentVersion,
      versions
    ),
  };
}
