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

/** The crates.io launcher manifest; its [package] version must match root. */
export const CARGO_SHIM_MANIFEST = 'packages/cargo-shim/Cargo.toml';

/** The launcher's committed lockfile. It records the crate's own version, and
 * the release job publishes with `--locked`, so a Cargo.toml bump without a
 * lockfile refresh must fail here instead of inside the release pipeline. */
export const CARGO_SHIM_LOCKFILE = 'packages/cargo-shim/Cargo.lock';

/** The crate name the lockstep check looks up inside Cargo.lock. */
export const CARGO_SHIM_CRATE = 'mangostudio';

interface VersionEntry {
  /** Manifest path (package.json, Cargo.toml, or Cargo.lock) relative to the repo root. */
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

function readTextFile(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`Cannot read ${label} at ${path}`, { cause });
  }
}

/** Read the `[package]` version from a Cargo.toml without a TOML dependency.
 * Dependency tables also carry `version =` keys, so parsing is section-aware.
 * // Usage: readCargoManifestVersion('/repo/packages/cargo-shim/Cargo.toml') */
export function readCargoManifestVersion(manifestPath: string): string {
  const raw = readTextFile(manifestPath, 'Cargo manifest');
  let inPackageSection = false;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    const section = trimmed.match(/^\[(.+)\]$/);
    if (section) {
      inPackageSection = section[1] === 'package';
      continue;
    }
    const version = inPackageSection && trimmed.match(/^version\s*=\s*"([^"]+)"/);
    if (version) {
      return version[1];
    }
  }
  throw new Error(`Missing "version" in [package] section of ${manifestPath}`);
}

/** Read one crate's resolved version from a Cargo.lock `[[package]]` entry.
 * // Usage: readCargoLockVersion('/repo/packages/cargo-shim/Cargo.lock', 'mangostudio') */
export function readCargoLockVersion(lockfilePath: string, crateName: string): string {
  const raw = readTextFile(lockfilePath, 'Cargo lockfile');
  let inNamedPackage = false;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '[[package]]') {
      inNamedPackage = false;
      continue;
    }
    const name = trimmed.match(/^name\s*=\s*"([^"]+)"/);
    if (name) {
      inNamedPackage = name[1] === crateName;
      continue;
    }
    const version = inNamedPackage && trimmed.match(/^version\s*=\s*"([^"]+)"/);
    if (version) {
      return version[1];
    }
  }
  throw new Error(`Cargo.lock at ${lockfilePath} does not list ${crateName}`);
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

/** Build the canary prerelease version for a main-branch commit:
 * `<root>-canary.<sha7>`, e.g. 0.1.0-canary.1234abc. The sha is truncated to 7
 * lowercase hex chars; a purely numeric short sha with a leading zero is an
 * illegal semver numeric identifier (semver.org §9), so it is prefixed with `g`
 * (git-describe style) to stay valid for npm package versions. The mutable
 * Docker `canary-<sha7>` tag uses the raw sha, where registry tags impose no such
 * rule.
 * // Usage: canaryReleaseVersion('1234abcdef0') -> '0.1.0-canary.1234abc' */
export function canaryReleaseVersion(sha: string, rootDir: string = ROOT_DIR): string {
  const normalized = sha.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(normalized)) {
    throw new Error(`Invalid commit sha "${sha}"; expected at least 7 hexadecimal characters.`);
  }
  const short = normalized.slice(0, 7);
  const identifier = /^0\d+$/.test(short) ? `g${short}` : short;
  const version = `${rootReleaseVersion(rootDir)}-canary.${identifier}`;
  assertValidVersion(version, 'canary sha');
  return version;
}

/** Build the rolling Cargo canary version for the current root version.
 * Unlike npm and Docker canaries, crates.io canary intentionally has no SHA
 * identifier because published crate versions are permanent.
 * // Usage: canaryCargoVersion() -> '0.1.0-canary' */
export function canaryCargoVersion(rootDir: string = ROOT_DIR): string {
  const version = `${rootReleaseVersion(rootDir)}-canary`;
  assertValidVersion(version, 'cargo canary');
  return version;
}

/** Read every lockstep manifest (package.json files plus the cargo-shim
 * Cargo.toml/Cargo.lock) and report versions that diverge from root.
 * // Usage: collectVersionConsistency().mismatches */
export function collectVersionConsistency(rootDir: string = ROOT_DIR): VersionConsistency {
  const entries: VersionEntry[] = [
    ...LOCKSTEP_PACKAGES.map((relativePath) => ({
      path: relativePath,
      version: readPackageVersion(join(rootDir, relativePath)),
    })),
    {
      path: CARGO_SHIM_MANIFEST,
      version: readCargoManifestVersion(join(rootDir, CARGO_SHIM_MANIFEST)),
    },
    {
      path: CARGO_SHIM_LOCKFILE,
      version: readCargoLockVersion(join(rootDir, CARGO_SHIM_LOCKFILE), CARGO_SHIM_CRATE),
    },
  ];

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
