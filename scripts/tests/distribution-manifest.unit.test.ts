import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertSafeDistributionArchiveEntries,
  createDistributionManifest,
  distributionArtifactName,
  parseDistributionManifest,
  validateDistributionManifest,
} from '../lib/distribution-manifest';
import { ALL_BINARY_TARGETS, releaseArchiveFileName } from '../lib/release-targets';

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs = [];
});

function fixture(): {
  rootDir: string;
  manifest: ReturnType<typeof createDistributionManifest>;
} {
  const rootDir = mkdtempSync(join(tmpdir(), 'mango-distribution-'));
  tempDirs.push(rootDir);
  mkdirSync(join(rootDir, '.mango', 'out'), { recursive: true });
  writeFileSync(join(rootDir, '.mango', 'out', 'README.md'), 'readme');
  mkdirSync(join(rootDir, 'release-assets'), { recursive: true });
  mkdirSync(join(rootDir, 'dist-npm', 'cli'), { recursive: true });
  writeFileSync(join(rootDir, 'release-assets', 'SHA256SUMS'), 'checksums');
  writeFileSync(join(rootDir, 'release-assets', 'frontend.tar.gz'), 'frontend');
  writeFileSync(join(rootDir, 'dist-npm', 'cli', 'package.json'), '{}');

  for (const target of ALL_BINARY_TARGETS) {
    const targetDir = join(rootDir, '.mango', 'out', target.arch);
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, target.name), target.arch);
    writeFileSync(
      join(rootDir, 'release-assets', releaseArchiveFileName('1.2.3', target)),
      `archive-${target.arch}`
    );
  }

  return {
    rootDir,
    manifest: createDistributionManifest({
      rootDir,
      sourceSha: 'ABCDEF0123456789',
      dirty: false,
      packageVersion: '1.2.3',
      channel: 'test',
      bunVersion: '1.3.14',
    }),
  };
}

describe('distribution manifest', () => {
  test('rejects traversal and absolute bundle entries before extraction', () => {
    expect(() =>
      assertSafeDistributionArchiveEntries([
        'distribution-manifest.json',
        '.mango/out/linux-x64/mangostudio',
      ])
    ).not.toThrow();
    for (const entry of ['../outside', 'nested/../../outside', '/etc/passwd', 'C:\\outside']) {
      expect(() => assertSafeDistributionArchiveEntries([entry])).toThrow(/Unsafe distribution/);
    }
  });

  test('is deterministically ordered and records build and package mappings', () => {
    const { manifest } = fixture();

    expect(manifest.sourceSha).toBe('abcdef0123456789');
    expect(manifest.targets).toHaveLength(ALL_BINARY_TARGETS.length);
    expect(manifest.files.map((file) => file.path)).toEqual(
      [...manifest.files.map((file) => file.path)].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0
      )
    );
    expect(manifest.targets.find((target) => target.id === 'linux-x64')?.npmPackage).toEqual({
      name: '@mangostudio/cli-linux-x64',
      directory: 'dist-npm/linux-x64',
    });
    expect(
      manifest.targets.find((target) => target.id === 'linux-x64-musl')?.npmPackage
    ).toBeNull();
  });

  test('promises the same archive layout the release archives actually contain', () => {
    const { manifest } = fixture();

    // extract-target.ts asserts the extracted members equal this list exactly,
    // so a binary that ships without being named here fails every smoke job.
    expect(manifest.targets.find((target) => target.id === 'linux-x64')?.archiveMembers).toEqual([
      'mangostudio',
      'mangostudio-runtime',
      'README.md',
    ]);
    expect(manifest.targets.find((target) => target.id === 'windows-x64')?.archiveMembers).toEqual([
      'mangostudio.exe',
      'mangostudio-runtime.exe',
      'README.md',
    ]);
  });

  // Every target now promises the same three members. This used to vary with
  // whether the build produced a vendored Cursor SDK tree for the arch, so it
  // is asserted across two targets rather than one.
  test('promises the same archive members on every target', () => {
    const { manifest } = fixture();

    for (const id of ['linux-x64', 'linux-arm64']) {
      expect(manifest.targets.find((target) => target.id === id)?.archiveMembers).toEqual([
        'mangostudio',
        'mangostudio-runtime',
        'README.md',
      ]);
    }
  });

  test('rejects duplicate target and file identities', () => {
    const { manifest } = fixture();
    const duplicateTarget = { ...manifest, targets: [...manifest.targets, manifest.targets[0]] };
    const duplicateFile = { ...manifest, files: [...manifest.files, manifest.files[0]] };

    expect(() => parseDistributionManifest(JSON.stringify(duplicateTarget))).toThrow(
      /Duplicate distribution target identity/
    );
    expect(() => parseDistributionManifest(JSON.stringify(duplicateFile))).toThrow(
      /Duplicate distribution file identity/
    );
  });

  test('rejects SHA, version, missing target, missing file, and checksum mismatches', () => {
    const { rootDir, manifest } = fixture();
    const base = {
      rootDir,
      sourceSha: manifest.sourceSha,
      packageVersion: '1.2.3',
      expect: 'built' as const,
    };

    expect(() => validateDistributionManifest(manifest, { ...base, sourceSha: '0000000' })).toThrow(
      /source SHA mismatch/
    );
    expect(() =>
      validateDistributionManifest(manifest, { ...base, packageVersion: '1.2.4' })
    ).toThrow(/version mismatch/);
    expect(() =>
      validateDistributionManifest(manifest, { ...base, target: 'missing-target' })
    ).toThrow(/target is missing/);

    const binary = join(rootDir, '.mango', 'out', 'linux-x64', 'mangostudio');
    rmSync(binary);
    expect(() => validateDistributionManifest(manifest, { ...base, target: 'linux-x64' })).toThrow(
      /file cannot be read/
    );
    writeFileSync(binary, 'tampered');
    expect(() => validateDistributionManifest(manifest, { ...base, target: 'linux-x64' })).toThrow(
      /mismatch/
    );
  });

  test('distinguishes built target layouts from downloaded target bundles', () => {
    const { rootDir, manifest } = fixture();
    const targetDir = join(rootDir, '.mango', 'out', 'linux-x64');
    const base = {
      rootDir,
      sourceSha: manifest.sourceSha,
      packageVersion: '1.2.3',
      target: 'linux-x64',
    };

    rmSync(targetDir, { force: true, recursive: true });

    expect(() =>
      validateDistributionManifest(manifest, { ...base, expect: 'downloaded' })
    ).not.toThrow();
    expect(() => validateDistributionManifest(manifest, base)).not.toThrow();
    expect(() => validateDistributionManifest(manifest, { ...base, expect: 'built' })).toThrow(
      /file cannot be read/
    );

    const archive = join(rootDir, 'release-assets', 'mangostudio-1.2.3-linux-x64.tar.gz');
    writeFileSync(archive, 'tampered');
    expect(() => validateDistributionManifest(manifest, { ...base, expect: 'downloaded' })).toThrow(
      /mismatch/
    );
  });

  test('validates manifest slices per consumer scope', () => {
    const { rootDir, manifest } = fixture();
    const base = {
      rootDir,
      sourceSha: manifest.sourceSha,
      packageVersion: '1.2.3',
      channel: 'test',
      expect: 'downloaded' as const,
    };

    rmSync(join(rootDir, 'dist-npm'), { force: true, recursive: true });
    expect(() =>
      validateDistributionManifest(manifest, { ...base, scope: 'checksums' })
    ).not.toThrow();
    expect(() => validateDistributionManifest(manifest, { ...base, scope: 'npm' })).toThrow(
      /file cannot be read/
    );

    rmSync(join(rootDir, 'release-assets', 'SHA256SUMS'));
    expect(() => validateDistributionManifest(manifest, { ...base, scope: 'checksums' })).toThrow(
      /file cannot be read/
    );
  });

  test('derives content-addressed packaged and per-target artifact names', () => {
    const bundleDigest = createHash('sha256').update('bundle').digest('hex');
    expect(distributionArtifactName('linux-x64', 'abcdef0123456789', '1.2.3', bundleDigest)).toBe(
      `distribution-linux-x64-abcdef012345-1.2.3-${bundleDigest.slice(0, 12)}`
    );
    expect(() =>
      distributionArtifactName('packaged', 'abcdef0123456789', '1.2.3', 'not-a-digest')
    ).toThrow(/bundle SHA-256/);
  });
});
