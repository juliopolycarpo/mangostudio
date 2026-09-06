import { describe, expect, test } from 'bun:test';
import { basename, join } from 'node:path';

import {
  CANARY_PAIR_PLATFORMS,
  createReleaseAssetPlan,
  platformArchiveMembers,
  selectCanaryAssets,
} from '../lib/release-assets';
import {
  ALL_BINARY_TARGETS,
  filterBinaryTargets,
  releaseArchiveFileName,
  releaseRawHubBinaryFileName,
  releaseRawRuntimeBinaryFileName,
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

describe('releaseRawBinaryFileName', () => {
  test('names raw hub and runtime assets without colliding with archives', () => {
    const linux = filterBinaryTargets('linux-x64')[0];
    const windows = filterBinaryTargets('windows-x64')[0];

    expect(releaseRawHubBinaryFileName('1.2.3', linux)).toBe('mangostudio-1.2.3-linux-x64');
    expect(releaseRawRuntimeBinaryFileName('1.2.3', linux)).toBe(
      'mangostudio-runtime-1.2.3-linux-x64'
    );
    expect(releaseRawHubBinaryFileName('1.2.3', windows)).toBe('mangostudio-1.2.3-windows-x64.exe');
    expect(releaseRawRuntimeBinaryFileName('1.2.3', windows)).toBe(
      'mangostudio-runtime-1.2.3-windows-x64.exe'
    );
  });
});

describe('createReleaseAssetPlan', () => {
  test('plans flat platform archives, raw binaries, frontend dist, and SHA256SUMS', () => {
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
    expect(plan.rawBinaries).toHaveLength(16);
    expect(plan.rawBinaries.map((asset) => asset.assetName)).toEqual([
      'mangostudio-1.2.3-linux-x64',
      'mangostudio-runtime-1.2.3-linux-x64',
      'mangostudio-1.2.3-linux-arm64',
      'mangostudio-runtime-1.2.3-linux-arm64',
      'mangostudio-1.2.3-windows-x64.exe',
      'mangostudio-runtime-1.2.3-windows-x64.exe',
      'mangostudio-1.2.3-windows-arm64.exe',
      'mangostudio-runtime-1.2.3-windows-arm64.exe',
      'mangostudio-1.2.3-darwin-x64',
      'mangostudio-runtime-1.2.3-darwin-x64',
      'mangostudio-1.2.3-darwin-arm64',
      'mangostudio-runtime-1.2.3-darwin-arm64',
      'mangostudio-1.2.3-linux-x64-musl',
      'mangostudio-runtime-1.2.3-linux-x64-musl',
      'mangostudio-1.2.3-linux-arm64-musl',
      'mangostudio-runtime-1.2.3-linux-arm64-musl',
    ]);
    expect(
      plan.rawBinaries.every(
        (asset) => asset.assetName.endsWith('.exe') === asset.assetName.includes('windows')
      )
    ).toBe(true);
    expect(plan.frontendArchive.assetName).toBe('mangostudio-1.2.3-frontend-dist.tar.gz');
    expect(plan.installerScripts.map((asset) => asset.assetName)).toEqual([
      'install.sh',
      'install.ps1',
    ]);
    expect(plan.installerScripts.map((asset) => asset.sourcePath)).toEqual([
      join('/repo', 'scripts', 'install', 'install.sh'),
      join('/repo', 'scripts', 'install', 'install.ps1'),
    ]);
    expect(plan.checksumPath).toBe(join('/repo', 'release-assets', 'SHA256SUMS'));
    expect(plan.checksummedAssetPaths.map((assetPath) => basename(assetPath))).toEqual([
      ...plan.platformArchives.map((asset) => asset.assetName),
      ...plan.rawBinaries.map((asset) => asset.assetName),
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
    expect(archive.readmePath).toBe(join('/repo', '.mango', 'out', 'README.md'));
    expect(plan.rawBinaries).toEqual([
      {
        sourcePath: join('/repo', '.mango', 'out', 'linux-x64', 'mangostudio'),
        assetName: 'mangostudio-1.2.3-linux-x64',
        assetPath: join('/repo', 'release-assets', 'mangostudio-1.2.3-linux-x64'),
        platform: 'linux-x64',
        kind: 'hub',
      },
      {
        sourcePath: join('/repo', '.mango', 'out', 'linux-x64', 'mangostudio-runtime'),
        assetName: 'mangostudio-runtime-1.2.3-linux-x64',
        assetPath: join('/repo', 'release-assets', 'mangostudio-runtime-1.2.3-linux-x64'),
        platform: 'linux-x64',
        kind: 'runtime',
      },
    ]);
  });

  test('rejects unknown platform filters', () => {
    expect(() =>
      createReleaseAssetPlan({ version: '1.2.3', rootDir: '/repo', onlyPlatform: 'freebsd-x64' })
    ).toThrow(/No release platform matches filter/);
  });
});

describe('selectCanaryAssets', () => {
  const plan = () => createReleaseAssetPlan({ version: '1.2.3', rootDir: '/repo' });

  test('publishes complete raw pairs for the curated platforms only', () => {
    expect(selectCanaryAssets(plan()).rawBinaries).toEqual([
      'mangostudio-1.2.3-linux-x64',
      'mangostudio-runtime-1.2.3-linux-x64',
      'mangostudio-1.2.3-darwin-arm64',
      'mangostudio-runtime-1.2.3-darwin-arm64',
      'mangostudio-1.2.3-windows-x64.exe',
      'mangostudio-runtime-1.2.3-windows-x64.exe',
    ]);
    expect(CANARY_PAIR_PLATFORMS).not.toContain('linux-arm64');
  });

  test('includes both install scripts under their own names', () => {
    expect(selectCanaryAssets(plan()).scripts).toEqual(['install.sh', 'install.ps1']);
  });

  // The Cargo launcher resolves `mangostudio-<version>-<its own platform>.<ext>`
  // from the rolling tag, so narrowing archives the way raw binaries are
  // narrowed would strand canary launchers on the five uncurated platforms.
  test('keeps every platform archive so the Cargo launcher can still resolve one', () => {
    const selection = selectCanaryAssets(plan());

    expect(selection.archives).toHaveLength(9);
    expect(selection.archives).toContain('mangostudio-1.2.3-linux-arm64.tar.gz');
    expect(selection.archives).toContain('mangostudio-1.2.3-windows-arm64.zip');
    expect(selection.archives).toContain('mangostudio-1.2.3-frontend-dist.tar.gz');
  });

  // The defect this replaced: a glob over the release plan silently absorbed
  // every raw hub binary the moment raw assets shipped. Selection by name means
  // a new asset type cannot change what canary uploads without changing this.
  test('does not widen when the release plan grows a new asset type', () => {
    const grown = plan();
    const widened = {
      ...grown,
      rawBinaries: [
        ...grown.rawBinaries,
        {
          sourcePath: '/repo/.mango/out/linux-x64/mangostudio-sidecar',
          assetName: 'mangostudio-sidecar-1.2.3-linux-x64',
          assetPath: '/repo/release-assets/mangostudio-sidecar-1.2.3-linux-x64',
          platform: 'linux-x64',
          kind: 'hub' as const,
        },
      ],
    };

    expect(selectCanaryAssets(widened).rawBinaries).toEqual(selectCanaryAssets(grown).rawBinaries);
  });

  test('refuses a platform that cannot contribute both halves of a pair', () => {
    const half = plan();
    const missingRuntime = {
      ...half,
      rawBinaries: half.rawBinaries.filter(
        (asset) => !(asset.platform === 'linux-x64' && asset.kind === 'runtime')
      ),
    };

    expect(() => selectCanaryAssets(missingRuntime)).toThrow(
      /linux-x64 has no complete hub\+runtime pair/
    );
  });
});

describe('platformArchiveMembers', () => {
  test('lists exactly the two binaries', () => {
    const [linux] = createReleaseAssetPlan({
      version: '1.2.3',
      rootDir: '/repo',
      onlyPlatform: 'linux-x64',
    }).platformArchives;

    expect(platformArchiveMembers(linux)).toEqual(['mangostudio', 'mangostudio-runtime']);
  });
});
