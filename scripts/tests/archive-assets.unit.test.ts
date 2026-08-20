import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { createReleaseAssetPlan, type ReleaseAssetPlan } from '../lib/release-assets';
import {
  filterBinaryTargets,
  type ReleasePlatformId,
  releaseArchiveFileName,
  runtimeBinaryName,
} from '../lib/release-targets';
import { archiveReleaseAssets } from '../release/archive-assets';

let tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mangostudio-release-assets-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }

  tempDirs = [];
});

// Save/restore per call (not via shared state) so nested or repeated use inside a
// single test cannot leak the overridden value into later tests.
const withArchiveConcurrency = async (value: string, run: () => Promise<void>): Promise<void> => {
  const previous = process.env.MANGO_ARCHIVE_CONCURRENCY;
  process.env.MANGO_ARCHIVE_CONCURRENCY = value;
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env.MANGO_ARCHIVE_CONCURRENCY;
    } else {
      process.env.MANGO_ARCHIVE_CONCURRENCY = previous;
    }
  }
};

const stageMuslPlatforms = (outDir: string, arches: readonly ReleasePlatformId[]): void => {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'README.md'), '# Standalone build\n');
  for (const arch of arches) {
    const sourceDir = join(outDir, arch);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'mangostudio'), 'binary');
    writeFileSync(join(sourceDir, 'mangostudio-runtime'), 'runtime binary');
  }
};

const stageFrontendDist = (rootDir: string): void => {
  const distDir = join(rootDir, 'apps', 'frontend', 'dist');
  mkdirSync(join(distDir, 'assets'), { recursive: true });
  writeFileSync(join(distDir, 'index.html'), '<html></html>');
};

const createMuslReleasePlan = (options: {
  rootDir: string;
  version: string;
  arches: readonly ReleasePlatformId[];
}): ReleaseAssetPlan => {
  const outDir = join(options.rootDir, 'out');
  const assetsDir = join(options.rootDir, 'release-assets');
  const targets = options.arches.flatMap((arch) => filterBinaryTargets(arch));
  const platformArchives = targets.map((target) => {
    const sourceDir = join(outDir, target.arch);
    const assetName = releaseArchiveFileName(options.version, target);
    return {
      platform: target,
      sourceDir,
      binaryPath: join(sourceDir, target.name),
      runtimeBinaryPath: join(sourceDir, runtimeBinaryName(target.name)),
      readmePath: join(outDir, 'README.md'),
      assetName,
      archivePath: join(assetsDir, assetName),
    };
  });
  const rawBinaries = platformArchives.flatMap((archive) => {
    const hubName = `mangostudio-${options.version}-${archive.platform.arch}`;
    const runtimeName = `mangostudio-runtime-${options.version}-${archive.platform.arch}`;
    return [
      {
        sourcePath: archive.binaryPath,
        assetName: hubName,
        assetPath: join(assetsDir, hubName),
        platform: archive.platform.arch,
        kind: 'hub',
      } as const,
      {
        sourcePath: archive.runtimeBinaryPath,
        assetName: runtimeName,
        assetPath: join(assetsDir, runtimeName),
        platform: archive.platform.arch,
        kind: 'runtime',
      } as const,
    ];
  });
  const frontendArchive = {
    sourceDir: join(options.rootDir, 'apps', 'frontend', 'dist'),
    assetName: `mangostudio-${options.version}-frontend-dist.tar.gz`,
    archivePath: join(assetsDir, `mangostudio-${options.version}-frontend-dist.tar.gz`),
  };

  return {
    rootDir: options.rootDir,
    outDir,
    assetsDir,
    platformArchives,
    rawBinaries,
    frontendArchive,
    checksummedAssetPaths: [
      ...platformArchives.map((archive) => archive.archivePath),
      ...rawBinaries.map((asset) => asset.assetPath),
      frontendArchive.archivePath,
    ],
    checksumPath: join(assetsDir, 'SHA256SUMS'),
  };
};

describe.serial('archiveReleaseAssets', () => {
  // What a platform archive needs is now just the two binaries and the README.
  // Kept as a rejection test rather than deleted: the vendored-SDK layout check
  // that used to live here was the only thing asserting the archive step
  // validates its inputs at all.
  test('rejects a platform whose runtime binary was never built', async () => {
    const rootDir = makeTempDir();
    const outDir = join(rootDir, 'out');
    const sourceDir = join(outDir, 'linux-x64');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'mangostudio'), 'binary');
    writeFileSync(join(outDir, 'README.md'), '# Standalone build\n');

    const plan = createReleaseAssetPlan({
      version: '1.2.3',
      rootDir,
      outDir,
      assetsDir: join(rootDir, 'release-assets'),
      onlyPlatform: 'linux-x64',
    });

    await expect(archiveReleaseAssets(plan)).rejects.toThrow(/runtime binary/);
  });

  test('writes every archive and checksum manifest with bounded parallelism', async () => {
    const rootDir = makeTempDir();
    const arches = ['linux-x64-musl', 'linux-arm64-musl'] as const;
    stageMuslPlatforms(join(rootDir, 'out'), arches);
    stageFrontendDist(rootDir);
    const plan = createMuslReleasePlan({ rootDir, version: '1.2.3', arches });

    await withArchiveConcurrency('4', async () => {
      await archiveReleaseAssets(plan);
    });

    for (const archive of plan.platformArchives) {
      expect(existsSync(archive.archivePath)).toBe(true);
    }
    for (const asset of plan.rawBinaries) {
      expect(existsSync(asset.assetPath)).toBe(true);
    }
    expect(existsSync(plan.frontendArchive.archivePath)).toBe(true);
    expect(existsSync(plan.checksumPath)).toBe(true);

    const checksumLines = readFileSync(plan.checksumPath, 'utf8').trimEnd().split('\n');
    expect(checksumLines.map((line) => line.split('  ')[1])).toEqual(
      plan.checksummedAssetPaths.map((assetPath) => basename(assetPath))
    );
    expect(
      plan.rawBinaries.every((asset) =>
        checksumLines.some((line) => line.endsWith(`  ${asset.assetName}`))
      )
    ).toBe(true);
  });

  test('produces identical SHA256SUMS for serial and parallel archiving', async () => {
    // Stage once and re-archive the same sources. Restaging between runs picks up
    // fresh file mtimes, and GNU tar embeds those in the archive, so checksums
    // diverge across a second boundary even when concurrency is irrelevant.
    const rootDir = makeTempDir();
    const arches = ['linux-x64-musl', 'linux-arm64-musl'] as const;
    stageMuslPlatforms(join(rootDir, 'out'), arches);
    stageFrontendDist(rootDir);
    const plan = createMuslReleasePlan({ rootDir, version: '9.9.9', arches });

    const runArchiving = async (concurrency: string): Promise<string> => {
      await withArchiveConcurrency(concurrency, async () => {
        await archiveReleaseAssets(plan);
      });
      return readFileSync(plan.checksumPath, 'utf8');
    };

    const serialChecksums = await runArchiving('1');
    const parallelChecksums = await runArchiving('4');
    expect(parallelChecksums).toBe(serialChecksums);
  });
});
