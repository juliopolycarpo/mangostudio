// Lockstep version bump used by scripts/release/prepare-release.ts. Rewrites
// every manifest release-version.ts checks (workspace package.json files plus
// the cargo-shim Cargo.toml/Cargo.lock) in two phases — transform everything,
// then write — so a bad manifest fails before any file changes and a partial
// bump is impossible.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { setCargoLockVersion, setCargoManifestVersion } from './cargo-version';
import { ROOT_DIR } from './config';
import {
  CARGO_SHIM_CRATE,
  CARGO_SHIM_LOCKFILE,
  CARGO_SHIM_MANIFEST,
  LOCKSTEP_PACKAGES,
  normalizeVersion,
  readCargoLockVersion,
  readCargoManifestVersion,
  readPackageVersion,
} from './release-version';

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Rewrite the top-level `version` field of a package.json source string,
 * preserving the file's formatting. Targets the exact current value (read via
 * JSON.parse) so a script or dependency key named "version" is never touched,
 * and round-trips the result to prove the right field changed.
 * // Usage: setPackageVersion(raw, '0.2.0') */
export function setPackageVersion(raw: string, version: string): string {
  let parsed: { version?: unknown };
  try {
    parsed = JSON.parse(raw) as { version?: unknown };
  } catch (cause) {
    throw new Error('Cannot bump version: invalid package.json JSON', { cause });
  }
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('Cannot bump version: package.json has no "version" field');
  }

  const field = new RegExp(`("version"\\s*:\\s*")${escapeRegExp(parsed.version)}(")`);
  const updated = raw.replace(field, `$1${version}$2`);
  const roundTrip = JSON.parse(updated) as { version?: unknown };
  if (roundTrip.version !== version) {
    throw new Error(
      `Cannot bump version: rewriting "${parsed.version}" -> "${version}" did not land on the top-level "version" field`
    );
  }
  return updated;
}

/** Bump every lockstep manifest (root + workspace package.json files, the
 * cargo-shim Cargo.toml, and its Cargo.lock) to `version`. Returns the
 * repo-relative paths written, in write order.
 * // Usage: bumpLockstepVersions('0.2.0') */
export function bumpLockstepVersions(
  version: string,
  rootDir: string = ROOT_DIR
): readonly string[] {
  const target = normalizeVersion(version);

  const writes = LOCKSTEP_PACKAGES.map((relativePath) => {
    const path = join(rootDir, relativePath);
    // Surfaces missing/malformed manifests with release-version.ts's messages
    // before setPackageVersion transforms the raw source.
    readPackageVersion(path);
    return { relativePath, path, content: setPackageVersion(readFileSync(path, 'utf8'), target) };
  });

  const manifestPath = join(rootDir, CARGO_SHIM_MANIFEST);
  const lockPath = join(rootDir, CARGO_SHIM_LOCKFILE);
  // The release-version readers surface a missing file or section with their
  // established messages before the stampers transform the raw source.
  readCargoManifestVersion(manifestPath);
  readCargoLockVersion(lockPath, CARGO_SHIM_CRATE);
  writes.push(
    {
      relativePath: CARGO_SHIM_MANIFEST,
      path: manifestPath,
      content: setCargoManifestVersion(readFileSync(manifestPath, 'utf8'), target),
    },
    {
      relativePath: CARGO_SHIM_LOCKFILE,
      path: lockPath,
      content: setCargoLockVersion(readFileSync(lockPath, 'utf8'), CARGO_SHIM_CRATE, target),
    }
  );

  for (const write of writes) {
    writeFileSync(write.path, write.content);
  }
  return writes.map((write) => write.relativePath);
}
