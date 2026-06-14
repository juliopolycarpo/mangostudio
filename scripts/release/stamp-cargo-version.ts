#!/usr/bin/env bun
// Stamp an ephemeral version into the cargo-shim manifest + lockfile so the
// canary job can `cargo publish` a prerelease without committing a version bump.
// CI-only: it mutates the working tree, then the workflow publishes with
// `cargo publish --locked --allow-dirty`.
// Usage: bun ./scripts/release/stamp-cargo-version.ts 0.1.0-canary.g123abc

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setCargoLockVersion, setCargoManifestVersion } from '../lib/cargo-version';
import { ROOT_DIR } from '../lib/config';
import {
  CARGO_SHIM_LOCKFILE,
  CARGO_SHIM_MANIFEST,
  isValidSemver,
  normalizeVersion,
} from '../lib/release-version';
import { error, success } from '../lib/runner';

const CRATE = 'mangostudio';

function main(): void {
  const input = (process.argv[2] ?? '').trim();
  if (!input) throw new Error('Usage: bun ./scripts/release/stamp-cargo-version.ts <version>');
  if (!isValidSemver(input)) throw new Error(`Invalid version "${input}"; expected semver.`);
  // cargo versions carry no leading `v`; normalize defensively.
  const version = normalizeVersion(input);

  const manifestPath = join(ROOT_DIR, CARGO_SHIM_MANIFEST);
  const lockPath = join(ROOT_DIR, CARGO_SHIM_LOCKFILE);
  writeFileSync(manifestPath, setCargoManifestVersion(readFileSync(manifestPath, 'utf8'), version));
  writeFileSync(lockPath, setCargoLockVersion(readFileSync(lockPath, 'utf8'), CRATE, version));
  success(`Stamped cargo-shim manifest + lockfile to ${version}.`);
}

try {
  main();
} catch (caught) {
  error(caught instanceof Error ? caught.message : String(caught));
  process.exit(1);
}
