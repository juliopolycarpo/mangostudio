import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bumpLockstepVersions, setPackageVersion } from '../lib/prepare-release';
import {
  CARGO_SHIM_LOCKFILE,
  CARGO_SHIM_MANIFEST,
  collectVersionConsistency,
  LOCKSTEP_PACKAGES,
  readPackageVersion,
} from '../lib/release-version';

// Named fake repo: seeds every lockstep manifest into an isolated temp dir so
// the filesystem-backed bump is tested without touching the real workspace.
class TempRepo {
  readonly dir: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'mango-prepare-'));
  }

  writeRaw(relativePath: string, content: string): void {
    const fullPath = join(this.dir, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  read(relativePath: string): string {
    return readFileSync(join(this.dir, relativePath), 'utf8');
  }

  seedLockstep(version: string): void {
    for (const relativePath of LOCKSTEP_PACKAGES) {
      this.writeRaw(
        relativePath,
        `${JSON.stringify({ name: relativePath, version, private: true }, null, 2)}\n`
      );
    }
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

describe('setPackageVersion', () => {
  test('rewrites only the top-level version field, preserving formatting', () => {
    const raw = [
      '{',
      '  "name": "@mangostudio/root",',
      '  "version": "0.1.0",',
      '  "scripts": {',
      '    "version": "echo version"',
      '  },',
      '  "devDependencies": { "version": "^1.0.0" }',
      '}',
      '',
    ].join('\n');
    const updated = setPackageVersion(raw, '0.2.0');
    expect(updated).toContain('  "version": "0.2.0",');
    // Same-named script and dependency keys survive untouched, as does layout.
    expect(updated).toContain('"version": "echo version"');
    expect(updated).toContain('"version": "^1.0.0"');
    expect(updated.endsWith('}\n')).toBe(true);
  });

  test('throws when the version field is missing or the JSON is malformed', () => {
    expect(() => setPackageVersion('{ "name": "x" }', '0.2.0')).toThrow(/no "version" field/);
    expect(() => setPackageVersion('{ not json', '0.2.0')).toThrow(/invalid package.json JSON/);
  });

  test('throws when the rewrite would land on the wrong field', () => {
    // A script value identical to the current version collides with the
    // targeted pattern; the round-trip check refuses the ambiguous rewrite.
    const raw = '{ "scripts": { "version": "0.1.0" }, "version": "0.1.0" }';
    expect(() => setPackageVersion(raw, '0.2.0')).toThrow(/did not land on the top-level/);
  });
});

describe('bumpLockstepVersions', () => {
  test('bumps every lockstep manifest to the target version', () => {
    repo.seedLockstep('0.1.0');
    const bumped = bumpLockstepVersions('0.2.0', repo.dir);

    expect(bumped).toEqual([...LOCKSTEP_PACKAGES, CARGO_SHIM_MANIFEST, CARGO_SHIM_LOCKFILE]);
    const result = collectVersionConsistency(repo.dir);
    expect(result.expected).toBe('0.2.0');
    expect(result.mismatches).toHaveLength(0);
    // Dependency pins survive both cargo rewrites.
    expect(repo.read(CARGO_SHIM_MANIFEST)).toContain('ureq = { version = "3"');
    expect(repo.read(CARGO_SHIM_LOCKFILE)).toContain('name = "flate2"\nversion = "1.1.9"');
  });

  test('normalizes a leading v before writing', () => {
    repo.seedLockstep('0.1.0');
    bumpLockstepVersions('v0.2.0', repo.dir);
    expect(collectVersionConsistency(repo.dir).expected).toBe('0.2.0');
  });

  test('a missing manifest fails before any file is written (no partial bump)', () => {
    repo.seedLockstep('0.1.0');
    rmSync(join(repo.dir, 'packages/cli/package.json'));

    expect(() => bumpLockstepVersions('0.2.0', repo.dir)).toThrow(/Cannot read package.json/);
    // Manifests read before the failure are untouched: transform-all happens
    // before write-any.
    expect(readPackageVersion(join(repo.dir, 'package.json'))).toBe('0.1.0');
    expect(readPackageVersion(join(repo.dir, 'apps/api/package.json'))).toBe('0.1.0');
  });

  test('a missing cargo lockfile fails without touching the package manifests', () => {
    repo.seedLockstep('0.1.0');
    rmSync(join(repo.dir, CARGO_SHIM_LOCKFILE));

    expect(() => bumpLockstepVersions('0.2.0', repo.dir)).toThrow(/Cannot read Cargo lockfile/);
    expect(readPackageVersion(join(repo.dir, 'package.json'))).toBe('0.1.0');
    expect(repo.read(CARGO_SHIM_MANIFEST)).toContain('version = "0.1.0"');
  });
});
