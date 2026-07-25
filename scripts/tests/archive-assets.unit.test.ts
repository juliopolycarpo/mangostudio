import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { createReleaseAssetPlan, type ReleaseAssetPlan } from '../lib/release-assets';
import {
  filterBinaryTargets,
  type ReleasePlatformId,
  releaseArchiveFileName,
} from '../lib/release-targets';
import { archiveReleaseAssets } from '../release/archive-assets';

let tempDirs: string[] = [];
let previousArchiveConcurrency: string | undefined;

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

  if (previousArchiveConcurrency === undefined) {
    delete process.env.MANGO_ARCHIVE_CONCURRENCY;
  } else {
    process.env.MANGO_ARCHIVE_CONCURRENCY = previousArchiveConcurrency;
  }
  previousArchiveConcurrency = undefined;
});

const withArchiveConcurrency = (value: string, run: () => Promise<void>): Promise<void> => {
  previousArchiveConcurrency = process.env.MANGO_ARCHIVE_CONCURRENCY;
  process.env.MANGO_ARCHIVE_CONCURRENCY = value;
  return run();
};

const stageMuslPlatforms = (outDir: string, arches: readonly ReleasePlatformId[]): void => {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'README.md'), '# Standalone build\n');
  for (const arch of arches) {
    const sourceDir = join(outDir, arch);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'mangostudio'), 'binary');
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
      cursorSidecarDir: join(sourceDir, 'cursor-sidecar'),
      readmePath: join(outDir, 'README.md'),
      assetName,
      archivePath: join(assetsDir, assetName),
    };
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
    frontendArchive,
    checksummedAssetPaths: [
      ...platformArchives.map((archive) => archive.archivePath),
      frontendArchive.archivePath,
    ],
    checksumPath: join(assetsDir, 'SHA256SUMS'),
  };
};

describe('archiveReleaseAssets', () => {
  test('rejects supported Cursor platforms when the sidecar is missing', async () => {
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

    await expect(archiveReleaseAssets(plan)).rejects.toThrow(
      /Invalid linux-x64 Cursor sidecar layout/
    );
  });

  test('rejects supported Cursor platforms when SDK chunks are missing', async () => {
    const rootDir = makeTempDir();
    const outDir = join(rootDir, 'out');
    const sourceDir = join(outDir, 'linux-x64');
    const sidecarDir = join(sourceDir, 'cursor-sidecar');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'mangostudio'), 'binary');
    writeFileSync(join(outDir, 'README.md'), '# Standalone build\n');
    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(join(sidecarDir, 'run-agent.mjs'), '#!/usr/bin/env node');
    writeFileSync(join(sidecarDir, 'sidecar-runtime.mjs'), 'export {};');
    mkdirSync(join(sidecarDir, 'node_modules', '@cursor', 'sdk'), { recursive: true });
    writeFileSync(
      join(sidecarDir, 'node_modules', '@cursor', 'sdk', 'package.json'),
      JSON.stringify({ name: '@cursor/sdk' })
    );
    mkdirSync(join(sidecarDir, 'node_modules', '@cursor', 'sdk-linux-x64'), { recursive: true });
    writeFileSync(
      join(sidecarDir, 'node_modules', '@cursor', 'sdk-linux-x64', 'package.json'),
      JSON.stringify({ name: '@cursor/sdk-linux-x64', bin: { rg: 'bin/rg' } })
    );

    const plan = createReleaseAssetPlan({
      version: '1.2.3',
      rootDir,
      outDir,
      assetsDir: join(rootDir, 'release-assets'),
      onlyPlatform: 'linux-x64',
    });

    await expect(archiveReleaseAssets(plan)).rejects.toThrow(/numbered chunks|chunk directory/);
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
    expect(existsSync(plan.frontendArchive.archivePath)).toBe(true);
    expect(existsSync(plan.checksumPath)).toBe(true);

    const checksumLines = readFileSync(plan.checksumPath, 'utf8').trimEnd().split('\n');
    expect(checksumLines.map((line) => line.split('  ')[1])).toEqual(
      plan.checksummedAssetPaths.map((assetPath) => basename(assetPath))
    );
  });

  test('produces identical SHA256SUMS for serial and parallel archiving', async () => {
    const runArchiving = async (concurrency: string): Promise<string> => {
      const rootDir = makeTempDir();
      const arches = ['linux-x64-musl', 'linux-arm64-musl'] as const;
      stageMuslPlatforms(join(rootDir, 'out'), arches);
      stageFrontendDist(rootDir);
      const plan = createMuslReleasePlan({ rootDir, version: '9.9.9', arches });

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
