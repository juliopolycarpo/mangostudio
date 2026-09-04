/**
 * What `detectNvm` and `detectFnm` genuinely share: comparing and sorting the
 * version strings both managers write as directory names, turning a raw
 * installed-version scan into the `ManagedVersion[]` shape the schema wants,
 * and the two findings every version-manager status can raise. Each
 * detector's own file layout, alias resolution, and root discovery stay in
 * that detector's own module — those differ enough between the two managers
 * that sharing them would cost more than it saves.
 */

import type { ManagedVersion, RuntimeFinding, VersionManagerId } from '../schemas';
import {
  classifyNodeLtsStatus,
  findNodeReleaseLine,
  type NodeReleaseSchedule,
  parseExactNodeVersion,
} from './lts-policy';

/**
 * The filesystem seams both detectors need: read a directory (`versions/node`,
 * `node-versions`), check whether a path exists, and follow a symlink or
 * junction to its target. nvm additionally reads file contents (`nvm.sh`, an
 * `alias/*` file); fnm's aliases are symlinks it never needs to read as text,
 * so its own filesystem type is exactly this one.
 */
export interface ManagedVersionFileSystem {
  readonly pathExists: (path: string) => boolean | Promise<boolean>;
  readonly readDirectory: (path: string) => Promise<readonly string[]>;
  readonly realpath: (path: string) => Promise<string>;
}

export async function listOptionalDirectory(
  fs: Pick<ManagedVersionFileSystem, 'readDirectory'>,
  path: string
): Promise<readonly string[]> {
  try {
    return await fs.readDirectory(path);
  } catch {
    return [];
  }
}

/** How both managers name a version directory: `24.18.0`, optionally `v`-prefixed. */
const VERSION_DIRECTORY_PATTERN = /^v?(\d+\.\d+\.\d+)$/;

/** One version directory, or `undefined` when it names no installed Node. */
async function readVersion(
  fs: Pick<ManagedVersionFileSystem, 'pathExists' | 'realpath'>,
  entry: string,
  nodeBinaryPathFor: (versionDirectory: string) => string
): Promise<{ version: string; path: string } | undefined> {
  const match = VERSION_DIRECTORY_PATTERN.exec(entry);
  if (!match) return undefined;
  const nodePath = nodeBinaryPathFor(entry);
  if (!(await fs.pathExists(nodePath))) return undefined;

  try {
    return { version: match[1] as string, path: await fs.realpath(nodePath) };
  } catch {
    // The binary exists, so retain its stable layout path when realpath fails.
    return { version: match[1] as string, path: nodePath };
  }
}

/**
 * The versions a manager has installed under `versionsRoot`, newest first.
 *
 * Only the binary's location differs between the two managers — nvm keeps it
 * at `<version>/bin/node`, fnm at `<version>/installation/bin/node` — so that
 * is the whole callback, and everything around it (which directory names
 * count as a version, that the binary must exist, that a failed realpath
 * keeps the layout path) is one rule rather than two.
 * // Usage: readManagedVersions(fs, '/home/a/.nvm/versions/node', (dir) => `/home/a/.nvm/versions/node/${dir}/bin/node`)
 */
export async function readManagedVersions(
  fs: Pick<ManagedVersionFileSystem, 'readDirectory' | 'pathExists' | 'realpath'>,
  versionsRoot: string,
  nodeBinaryPathFor: (versionDirectory: string) => string
): Promise<Array<{ version: string; path: string }>> {
  const entries = await listOptionalDirectory(fs, versionsRoot);

  // Each version directory is independent, so the `pathExists`/`realpath` pair
  // goes out for all of them at once rather than one round trip at a time —
  // a machine with eight installed versions pays two waves, not sixteen hops.
  const versions = await Promise.all(
    entries.map((entry) => readVersion(fs, entry, nodeBinaryPathFor))
  );

  return sortVersionsDescending(versions.filter((version) => version !== undefined));
}

/**
 * Ascending exact-semver comparison for the version strings nvm and fnm both
 * write as directory names (`24.18.0`, optionally `v`-prefixed on disk).
 * Anything that does not parse falls back to lexical order rather than
 * throwing — a directory a version manager did not create should still sort
 * somewhere, not abort the scan.
 */
export function compareVersionStrings(left: string, right: string): number {
  const leftVersion = parseExactNodeVersion(left);
  const rightVersion = parseExactNodeVersion(right);
  if (!leftVersion || !rightVersion) return left.localeCompare(right);
  if (leftVersion.major !== rightVersion.major) return leftVersion.major - rightVersion.major;
  if (leftVersion.minor !== rightVersion.minor) return leftVersion.minor - rightVersion.minor;
  return leftVersion.patch - rightVersion.patch;
}

/** Descending by version, newest first — the order both managers' `versions` lists render in. */
export function sortVersionsDescending<T extends { readonly version: string }>(
  versions: readonly T[]
): T[] {
  return [...versions].sort((left, right) => compareVersionStrings(right.version, left.version));
}

/**
 * Keeps the newest version seen for each major, seeding the map
 * `classifyNodeLtsStatus` compares a line's latest patch against.
 */
export function preferNewerVersion(latestByMajor: Map<number, string>, versionValue: string): void {
  const version = parseExactNodeVersion(versionValue);
  if (!version) return;
  const existing = latestByMajor.get(version.major);
  if (!existing || compareVersionStrings(versionValue, existing) > 0) {
    latestByMajor.set(version.major, versionValue);
  }
}

/**
 * Path equality for comparing a manager's installed-version paths against the
 * effective Node path a runtime scan reported: exact on POSIX, case-
 * insensitive on Windows. Distinct from `binary-scan.ts`'s own
 * `normalizedPath`, which always lowercases — that one classifies *any*
 * runtime's path, this one only ever compares two paths on the same host.
 */
export function normalizedManagedPath(path: string, platform: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Which installed version is the one actually running, found by comparing
 * each candidate's resolved path against the effective Node path the same
 * scan the toolchain tab shows already reported.
 */
export function findCurrentVersion(
  installed: readonly { readonly version: string; readonly path: string }[],
  currentNodePath: string | undefined,
  platform: string
): string | undefined {
  if (currentNodePath === undefined) return undefined;
  const currentPath = normalizedManagedPath(currentNodePath, platform);
  return installed.find((version) => normalizedManagedPath(version.path, platform) === currentPath)
    ?.version;
}

export interface ManagedVersionListOptions {
  readonly schedule: NodeReleaseSchedule;
  readonly now: Date;
  readonly latestByMajor: ReadonlyMap<number, string>;
  readonly liveDataAvailable: boolean | undefined;
  readonly defaultVersion: string | undefined;
  readonly currentVersion: string | undefined;
}

/**
 * Turns a manager's raw installed-version scan into the `ManagedVersion[]`
 * both `detectNvm` and `detectFnm` publish: LTS status per version, plus the
 * default/current flags derived from what the caller already resolved.
 */
export function toManagedVersions(
  installed: readonly { readonly version: string; readonly path: string }[],
  options: ManagedVersionListOptions
): ManagedVersion[] {
  return installed.map((version) => {
    const releaseLine = findNodeReleaseLine(options.schedule, version.version);
    return {
      version: version.version,
      path: version.path,
      isDefault: version.version === options.defaultVersion,
      isCurrent: version.version === options.currentVersion,
      ltsStatus: classifyNodeLtsStatus(version.version, options.schedule, {
        now: options.now,
        latestByMajor: options.latestByMajor,
        liveDataAvailable: options.liveDataAvailable,
      }),
      ...(releaseLine?.codename !== undefined && { ltsCodename: releaseLine.codename }),
    };
  });
}

/**
 * Findings both detectors raise from the same shape of answer: a configured
 * default that never landed on `PATH`, and any managed version whose LTS
 * classification has fallen behind.
 */
export function createManagedVersionFindings(
  manager: VersionManagerId,
  defaultAlias: string | undefined,
  defaultVersion: string | undefined,
  currentVersion: string | undefined,
  versions: readonly ManagedVersion[]
): RuntimeFinding[] {
  const findings: RuntimeFinding[] = [];
  if (defaultAlias && !currentVersion) {
    findings.push({
      code: 'managed-but-not-on-path',
      params: {
        manager,
        defaultAlias,
        ...(defaultVersion !== undefined && { defaultVersion }),
      },
    });
  }

  for (const version of versions) {
    if (version.ltsStatus !== 'lts-outdated-patch' && version.ltsStatus !== 'lts-superseded') {
      continue;
    }
    findings.push({
      code: 'outdated-lts',
      params: { version: version.version, ltsStatus: version.ltsStatus },
    });
  }
  return findings;
}
