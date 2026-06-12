import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assertVersionsInLockstep,
  CARGO_SHIM_LOCKFILE,
  CARGO_SHIM_MANIFEST,
  collectVersionConsistency,
  isValidSemver,
  LOCKSTEP_PACKAGES,
  normalizeVersion,
  readCargoLockVersion,
  readCargoManifestVersion,
  readPackageVersion,
  resolveReleaseVersion,
  rootReleaseVersion,
} from '../lib/release-version';

// Named fake repo: writes package.json fixtures into an isolated temp dir so the
// filesystem-backed resolver is tested without touching the real workspace.
class TempRepo {
  readonly dir: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'mango-version-'));
  }

  writePackage(relativePath: string, version: string | null): void {
    const manifest = version === null ? { name: relativePath } : { name: relativePath, version };
    this.writeRaw(relativePath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  writeRaw(relativePath: string, content: string): void {
    const fullPath = join(this.dir, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  writeCargoManifest(version: string): void {
    this.writeRaw(
      CARGO_SHIM_MANIFEST,
      [
        '[package]',
        'name = "mangostudio"',
        `version = "${version}"`,
        'edition = "2021"',
        '',
        '[dependencies]',
        'ureq = { version = "3", default-features = false }',
        '',
      ].join('\n')
    );
  }

  writeCargoLock(version: string): void {
    this.writeRaw(
      CARGO_SHIM_LOCKFILE,
      [
        'version = 4',
        '',
        '[[package]]',
        'name = "flate2"',
        'version = "1.1.9"',
        '',
        '[[package]]',
        'name = "mangostudio"',
        `version = "${version}"`,
        'dependencies = ["flate2"]',
        '',
      ].join('\n')
    );
  }

  seedLockstep(version: string): void {
    for (const relativePath of LOCKSTEP_PACKAGES) {
      this.writePackage(relativePath, version);
    }
    this.writeCargoManifest(version);
    this.writeCargoLock(version);
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

let repo: TempRepo;

beforeEach(() => {
  repo = new TempRepo();
});

afterEach(() => {
  repo.cleanup();
});

describe('normalizeVersion', () => {
  test('strips a single leading v and surrounding whitespace', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
    expect(normalizeVersion('  1.2.3  ')).toBe('1.2.3');
    expect(normalizeVersion('1.2.3')).toBe('1.2.3');
  });
});

describe('isValidSemver', () => {
  test('accepts release, prefixed, and prerelease versions', () => {
    expect(isValidSemver('1.2.3')).toBe(true);
    expect(isValidSemver('v1.2.3')).toBe(true);
    expect(isValidSemver('1.2.3-rc.1')).toBe(true);
    expect(isValidSemver('1.0.0-alpha+001')).toBe(true);
  });

  test('rejects malformed versions', () => {
    expect(isValidSemver('')).toBe(false);
    expect(isValidSemver('1.2')).toBe(false);
    expect(isValidSemver('1.2.3.4')).toBe(false);
    expect(isValidSemver('01.2.3')).toBe(false);
    expect(isValidSemver('abc')).toBe(false);
  });
});

describe('readPackageVersion', () => {
  test('returns the version field', () => {
    repo.writePackage('package.json', '1.4.0');
    expect(readPackageVersion(join(repo.dir, 'package.json'))).toBe('1.4.0');
  });

  test('throws when the version field is missing', () => {
    repo.writePackage('package.json', null);
    expect(() => readPackageVersion(join(repo.dir, 'package.json'))).toThrow(/Missing "version"/);
  });

  test('throws when the file is missing', () => {
    expect(() => readPackageVersion(join(repo.dir, 'package.json'))).toThrow(/Cannot read/);
  });

  test('throws on malformed JSON', () => {
    repo.writeRaw('package.json', '{ not json');
    expect(() => readPackageVersion(join(repo.dir, 'package.json'))).toThrow(/Invalid JSON/);
  });
});

describe('rootReleaseVersion', () => {
  test('reads and normalizes the root version', () => {
    repo.writePackage('package.json', '2.0.0');
    expect(rootReleaseVersion(repo.dir)).toBe('2.0.0');
  });

  test('throws when the root version is not semver', () => {
    repo.writePackage('package.json', 'not-semver');
    expect(() => rootReleaseVersion(repo.dir)).toThrow(/Invalid release version/);
  });
});

describe('resolveReleaseVersion', () => {
  test('uses the env override and strips a leading v', () => {
    // No root package.json on disk proves the override path never reads it.
    expect(resolveReleaseVersion({ envVersion: 'v3.1.4', rootDir: repo.dir })).toBe('3.1.4');
  });

  test('falls back to the root version when the override is empty', () => {
    repo.writePackage('package.json', '0.5.0');
    expect(resolveReleaseVersion({ envVersion: '', rootDir: repo.dir })).toBe('0.5.0');
  });

  test('throws on an invalid env override', () => {
    expect(() => resolveReleaseVersion({ envVersion: 'nope', rootDir: repo.dir })).toThrow(
      /Invalid release version "nope" from VERSION/
    );
  });

  test('throws on an invalid root version when no override is set', () => {
    repo.writePackage('package.json', '1.2');
    expect(() => resolveReleaseVersion({ envVersion: '', rootDir: repo.dir })).toThrow(
      /Invalid release version/
    );
  });
});

describe('readCargoManifestVersion', () => {
  test('returns the [package] version, not dependency versions', () => {
    repo.writeCargoManifest('1.4.0');
    expect(readCargoManifestVersion(join(repo.dir, CARGO_SHIM_MANIFEST))).toBe('1.4.0');
  });

  test('throws when no [package] section carries a version', () => {
    repo.writeRaw(CARGO_SHIM_MANIFEST, '[dependencies]\nureq = "3"\nversion = "9.9.9"\n');
    expect(() => readCargoManifestVersion(join(repo.dir, CARGO_SHIM_MANIFEST))).toThrow(
      /Missing "version" in \[package\]/
    );
  });

  test('throws when the manifest file is missing', () => {
    expect(() => readCargoManifestVersion(join(repo.dir, CARGO_SHIM_MANIFEST))).toThrow(
      /Cannot read Cargo manifest/
    );
  });
});

describe('readCargoLockVersion', () => {
  test('returns the version of the named crate among other packages', () => {
    repo.writeCargoLock('1.4.0');
    expect(readCargoLockVersion(join(repo.dir, CARGO_SHIM_LOCKFILE), 'mangostudio')).toBe('1.4.0');
  });

  test('throws when the crate is not listed', () => {
    repo.writeCargoLock('1.4.0');
    expect(() => readCargoLockVersion(join(repo.dir, CARGO_SHIM_LOCKFILE), 'missing')).toThrow(
      /does not list missing/
    );
  });

  test('throws when the lockfile is missing', () => {
    expect(() => readCargoLockVersion(join(repo.dir, CARGO_SHIM_LOCKFILE), 'mangostudio')).toThrow(
      /Cannot read Cargo lockfile/
    );
  });
});

describe('collectVersionConsistency', () => {
  test('reports no mismatches when every package agrees', () => {
    repo.seedLockstep('0.1.0');
    const result = collectVersionConsistency(repo.dir);
    expect(result.expected).toBe('0.1.0');
    expect(result.entries).toHaveLength(LOCKSTEP_PACKAGES.length + 2);
    expect(result.mismatches).toHaveLength(0);
  });

  test('reports packages that diverge from the root version', () => {
    repo.seedLockstep('0.1.0');
    repo.writePackage('apps/api/package.json', '0.2.0');
    const result = collectVersionConsistency(repo.dir);
    expect(result.mismatches).toEqual([{ path: 'apps/api/package.json', version: '0.2.0' }]);
  });

  test('reports a drifted Cargo.toml', () => {
    repo.seedLockstep('0.1.0');
    repo.writeCargoManifest('0.2.0');
    const result = collectVersionConsistency(repo.dir);
    expect(result.mismatches).toEqual([{ path: CARGO_SHIM_MANIFEST, version: '0.2.0' }]);
  });

  test('reports a Cargo.lock that missed the version bump', () => {
    repo.seedLockstep('0.2.0');
    repo.writeCargoLock('0.1.0');
    const result = collectVersionConsistency(repo.dir);
    expect(result.mismatches).toEqual([{ path: CARGO_SHIM_LOCKFILE, version: '0.1.0' }]);
  });
});

describe('assertVersionsInLockstep', () => {
  test('returns the report when versions are consistent', () => {
    repo.seedLockstep('1.0.0');
    expect(assertVersionsInLockstep(repo.dir).expected).toBe('1.0.0');
  });

  test('throws listing the drifted packages', () => {
    repo.seedLockstep('1.0.0');
    repo.writePackage('packages/cli/package.json', '1.1.0');
    expect(() => assertVersionsInLockstep(repo.dir)).toThrow(/packages\/cli\/package.json: 1.1.0/);
  });

  test('throws when the root version is not semver', () => {
    repo.seedLockstep('not-semver');
    expect(() => assertVersionsInLockstep(repo.dir)).toThrow(/Invalid release version/);
  });
});
