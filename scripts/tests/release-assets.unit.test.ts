import { describe, expect, test } from 'bun:test';
import { basename, join } from 'node:path';

import { createReleaseAssetPlan } from '../lib/release-assets';
import {
  ALL_BINARY_TARGETS,
  filterBinaryTargets,
  releaseArchiveFileName,
} from '../lib/release-targets';

describe('release targets', () => {
  test('covers every standalone platform with the expected archive format', () => {
    expect(ALL_BINARY_TARGETS.map((target) => [target.arch, target.archiveFormat])).toEqual([
      ['linux-x64', 'tar.gz'],
      ['linux-arm64', 'tar.gz'],
      ['windows-x64', 'zip'],
      ['windows-arm64', 'zip'],
      ['darwin-x64', 'tar.gz'],
      ['darwin-arm64', 'tar.gz'],
      ['linux-x64-musl', 'tar.gz'],
      ['linux-arm64-musl', 'tar.gz'],
    ]);
  });

  test('filters by public platform id or Bun target id', () => {
    expect(filterBinaryTargets('linux-x64').map((target) => target.arch)).toEqual(['linux-x64']);
    expect(filterBinaryTargets('bun-windows-arm64').map((target) => target.arch)).toEqual([
      'windows-arm64',
    ]);
  });
});

describe('releaseArchiveFileName', () => {
  test('uses tarballs for Unix targets and zip files for Windows targets', () => {
    const linux = filterBinaryTargets('linux-x64')[0];
    const windows = filterBinaryTargets('windows-x64')[0];

    expect(releaseArchiveFileName('1.2.3', linux)).toBe('mangostudio-1.2.3-linux-x64.tar.gz');
    expect(releaseArchiveFileName('1.2.3', windows)).toBe('mangostudio-1.2.3-windows-x64.zip');
  });
});

describe('createReleaseAssetPlan', () => {
  test('plans flat platform archives, frontend dist, installers, and SHA256SUMS', () => {
    const plan = createReleaseAssetPlan({ version: '1.2.3', rootDir: '/repo' });

    expect(plan.platformArchives.map((asset) => asset.assetName)).toEqual([
      'mangostudio-1.2.3-linux-x64.tar.gz',
      'mangostudio-1.2.3-linux-arm64.tar.gz',
      'mangostudio-1.2.3-windows-x64.zip',
      'mangostudio-1.2.3-windows-arm64.zip',
      'mangostudio-1.2.3-darwin-x64.tar.gz',
      'mangostudio-1.2.3-darwin-arm64.tar.gz',
      'mangostudio-1.2.3-linux-x64-musl.tar.gz',
      'mangostudio-1.2.3-linux-arm64-musl.tar.gz',
    ]);
    expect(plan.frontendArchive.assetName).toBe('mangostudio-1.2.3-frontend-dist.tar.gz');
    expect(plan.installerAssets.map((asset) => asset.assetName)).toEqual([
      'install.sh',
      'install.ps1',
    ]);
    expect(plan.checksumPath).toBe(join('/repo', 'release-assets', 'SHA256SUMS'));
    expect(plan.checksummedAssetPaths.map((assetPath) => basename(assetPath))).toEqual([
      ...plan.platformArchives.map((asset) => asset.assetName),
      'mangostudio-1.2.3-frontend-dist.tar.gz',
      'install.sh',
      'install.ps1',
    ]);
  });

  test('plans paths for a single platform filter', () => {
    const plan = createReleaseAssetPlan({
      version: '1.2.3',
      rootDir: '/repo',
      onlyPlatform: 'linux-x64',
    });
    const [archive] = plan.platformArchives;

    expect(plan.platformArchives).toHaveLength(1);
    expect(archive.sourceDir).toBe(join('/repo', '.mango', 'out', 'linux-x64'));
    expect(archive.binaryPath).toBe(join('/repo', '.mango', 'out', 'linux-x64', 'mangostudio'));
    expect(archive.publicDir).toBe(join('/repo', '.mango', 'out', 'linux-x64', 'public'));
    expect(archive.readmePath).toBe(join('/repo', '.mango', 'out', 'README.md'));
  });

  test('rejects unknown platform filters', () => {
    expect(() =>
      createReleaseAssetPlan({ version: '1.2.3', rootDir: '/repo', onlyPlatform: 'freebsd-x64' })
    ).toThrow(/No release platform matches filter/);
  });
});
