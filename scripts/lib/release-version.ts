// Single source of truth for the release version used by the binary build, the
// npm packaging step, and the changelog. The root package.json version is
// canonical; the VERSION env var (set by the release workflow from the pushed
// tag) overrides it. Every consumer validates against semver here, so a typo
// fails before any mislabeled artifact is produced.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from './config';

// Official semver grammar (https://semver.org), anchored. Accepts optional
// prerelease and build metadata so a tag like 1.2.3-rc.1 still validates.
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** package.json files that must all carry the same version on release.
 * Usage: LOCKSTEP_PACKAGES.map((rel) => join(rootDir, rel)) */
export const LOCKSTEP_PACKAGES: readonly string[] = [
  'package.json',
  'apps/api/package.json',
  'apps/frontend/package.json',
  'apps/shared/package.json',
  'packages/cli/package.json',
];

export interface VersionEntry {
  /** package.json path relative to the repo root. */
  readonly path: string;
  readonly version: string;
}

export interface VersionConsistency {
  /** The root package.json version every entry must match. */
  readonly expected: string;
  readonly entries: readonly VersionEntry[];
  readonly mismatches: readonly VersionEntry[];
}

export interface ResolveReleaseVersionOptions {
  /** Override source; defaults to process.env.VERSION. */
  readonly envVersion?: string | undefined;
  /** Repo root holding the canonical package.json; defaults to ROOT_DIR. */
  readonly rootDir?: string;
}

/** Drop a single leading `v` plus surrounding whitespace.
 * // Usage: normalizeVersion('v1.2.3') -> '1.2.3' */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/, '');
}

/** True when `version` is valid semver after normalization.
 * // Usage: isValidSemver('1.2.3') -> true */
export function isValidSemver(version: string): boolean {
  return SEMVER_PATTERN.test(normalizeVersion(version));
}

function assertValidVersion(version: string, source: string): void {
  if (!isValidSemver(version)) {
    throw new Error(
      `Invalid release version "${version}" from ${source}. Expected semver like 1.2.3.`
    );
  }
}

/** Read the `version` field from a package.json, throwing on a missing file,
 * malformed JSON, or an empty version.
 * // Usage: readPackageVersion('/repo/package.json') -> '0.1.0' */
export function readPackageVersion(packageJsonPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(packageJsonPath, 'utf8');
  } catch (cause) {
    throw new Error(`Cannot read package.json at ${packageJsonPath}`, { cause });
  }

  let parsed: { version?: unknown };
  try {
    parsed = JSON.parse(raw) as { version?: unknown };
  } catch (cause) {
    throw new Error(`Invalid JSON in ${packageJsonPath}`, { cause });
  }

  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error(`Missing "version" field in ${packageJsonPath}`);
  }
  return parsed.version;
}

/** The canonical committed version: the root package.json `version`, validated.
 * // Usage: rootReleaseVersion() -> '0.1.0' */
export function rootReleaseVersion(rootDir: string = ROOT_DIR): string {
  const path = join(rootDir, 'package.json');
  const version = normalizeVersion(readPackageVersion(path));
  assertValidVersion(version, path);
  return version;
}

/** The version every release artifact should carry: the VERSION env override
 * when set, otherwise the root package.json version. Throws when the chosen
 * value is not valid semver, so builds fail before mislabeling artifacts.
 * // Usage: resolveReleaseVersion() -> '0.1.0' */
export function resolveReleaseVersion(options: ResolveReleaseVersionOptions = {}): string {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const override = (options.envVersion ?? process.env.VERSION ?? '').trim();
  if (override.length === 0) {
    return rootReleaseVersion(rootDir);
  }

  const normalized = normalizeVersion(override);
  assertValidVersion(normalized, 'VERSION');
  return normalized;
}

/** Read every lockstep package.json and report versions that diverge from root.
 * // Usage: collectVersionConsistency().mismatches */
export function collectVersionConsistency(rootDir: string = ROOT_DIR): VersionConsistency {
  const entries = LOCKSTEP_PACKAGES.map((relativePath) => ({
    path: relativePath,
    version: readPackageVersion(join(rootDir, relativePath)),
  }));

  const expected = entries[0].version;
  const mismatches = entries.filter((entry) => entry.version !== expected);
  return { expected, entries, mismatches };
}

/** Assert the root version is valid semver and every lockstep package matches it.
 * Returns the consistency report on success.
 * // Usage: assertVersionsInLockstep() */
export function assertVersionsInLockstep(rootDir: string = ROOT_DIR): VersionConsistency {
  const result = collectVersionConsistency(rootDir);
  assertValidVersion(result.expected, join(rootDir, 'package.json'));

  if (result.mismatches.length > 0) {
    const detail = result.mismatches
      .map((entry) => `${entry.path}: ${entry.version}`)
      .join('\n  - ');
    throw new Error(`Workspace versions drifted from root ${result.expected}:\n  - ${detail}`);
  }
  return result;
}
