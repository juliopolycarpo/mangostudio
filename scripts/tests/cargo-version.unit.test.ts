import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cargoLockVersion,
  setCargoLockVersion,
  setCargoManifestVersion,
} from '../lib/cargo-version';
import { readCargoLockVersion, readCargoManifestVersion } from '../lib/release-version';

const MANIFEST = [
  '[package]',
  'name = "mangostudio"',
  'version = "0.1.0"',
  'edition = "2021"',
  '',
  '[dependencies]',
  'ureq = { version = "3", default-features = false }',
  '',
].join('\n');

const LOCKFILE = [
  'version = 4',
  '',
  '[[package]]',
  'name = "flate2"',
  'version = "1.1.9"',
  '',
  '[[package]]',
  'name = "mangostudio"',
  'version = "0.1.0"',
  'dependencies = ["flate2"]',
  '',
].join('\n');

const CANARY = '0.1.0-canary';

describe('cargoLockVersion', () => {
  test('reads the named package, not the first version line in the file', () => {
    expect(cargoLockVersion(LOCKFILE, 'mangostudio')).toBe('0.1.0');
    expect(cargoLockVersion(LOCKFILE, 'flate2')).toBe('1.1.9');
  });

  test('returns undefined for a crate the lockfile does not list', () => {
    expect(cargoLockVersion(LOCKFILE, 'absent')).toBeUndefined();
  });
});

describe('setCargoManifestVersion', () => {
  test('rewrites the [package] version, leaving dependency versions untouched', () => {
    const updated = setCargoManifestVersion(MANIFEST, CANARY);
    expect(updated).toContain(`version = "${CANARY}"`);
    // The ureq dependency's own version pin must survive.
    expect(updated).toContain('ureq = { version = "3", default-features = false }');
  });

  test('throws when no [package] version is present', () => {
    expect(() => setCargoManifestVersion('[dependencies]\nureq = "3"\n', CANARY)).toThrow(
      /No \[package\] version/
    );
  });
});

describe('setCargoLockVersion', () => {
  test('rewrites only the named crate version', () => {
    const updated = setCargoLockVersion(LOCKFILE, 'mangostudio', CANARY);
    expect(updated).toContain(`name = "mangostudio"\nversion = "${CANARY}"`);
    // Sibling crate versions stay pinned.
    expect(updated).toContain('name = "flate2"\nversion = "1.1.9"');
  });

  test('throws when the crate is not listed', () => {
    expect(() => setCargoLockVersion(LOCKFILE, 'missing', CANARY)).toThrow(/does not list missing/);
  });
});

describe('round-trips through the release-version readers', () => {
  test('a stamped manifest + lockfile read back the stamped version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mango-cargo-stamp-'));
    try {
      const manifestPath = join(dir, 'Cargo.toml');
      const lockPath = join(dir, 'Cargo.lock');
      writeFileSync(manifestPath, setCargoManifestVersion(MANIFEST, CANARY));
      writeFileSync(lockPath, setCargoLockVersion(LOCKFILE, 'mangostudio', CANARY));

      expect(readCargoManifestVersion(manifestPath)).toBe(CANARY);
      expect(readCargoLockVersion(lockPath, 'mangostudio')).toBe(CANARY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
