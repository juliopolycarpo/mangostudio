import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { BUILD_STATE_FILE } from '@mangostudio/shared/utils/dist-files';
import { openTarArchive } from '../lib/archive';
import { createReleaseAssetPlan, type ReleaseAssetPlan } from '../lib/release-assets';
import {
  filterBinaryTargets,
  type ReleasePlatformId,
  releaseArchiveFileName,
  runtimeBinaryName,
} from '../lib/release-targets';
import { archiveReleaseAssets } from '../release/archive-assets';
import { extractTargetArchive } from '../release/extract-target';

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

/**
 * The output directory `build.ts` leaves when a runtime fails verification: both binaries are
 * staged (the runtime is copied before it is checked) but the README is only written once every
 * platform has built and passed.
 */
const stageFailedVerificationBuild = (outDir: string, arch: ReleasePlatformId): void => {
  const sourceDir = join(outDir, arch);
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, 'mangostudio'), 'binary');
  writeFileSync(join(sourceDir, 'mangostudio-runtime'), 'runtime that failed verification');
};

const stageFrontendDist = (rootDir: string): void => {
  const distDir = join(rootDir, 'apps', 'frontend', 'dist');
  mkdirSync(join(distDir, 'assets'), { recursive: true });
  writeFileSync(join(distDir, 'index.html'), '<html></html>');
  // Every build writes this. It is the dev server's staleness stamp, meaningless
  // to whoever untars a release, and the archive is the whole directory.
  writeFileSync(join(distDir, BUILD_STATE_FILE), '{"apiUrl":"","mode":"production"}');
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
    // This plan's own focus is muslPlatforms/checksums; leaving this empty
    // means copyInstallerScripts has nothing to do and no fixture is needed.
    installerScripts: [],
    checksummedAssetPaths: [
      ...platformArchives.map((archive) => archive.archivePath),
      ...rawBinaries.map((asset) => asset.assetPath),
      frontendArchive.archivePath,
    ],
    checksumPath: join(assetsDir, 'SHA256SUMS'),
  };
};

describe.serial('archiveReleaseAssets', () => {
  test('writes a flat Windows ZIP with matching binaries and checksum', async () => {
    const rootDir = makeTempDir();
    const outDir = join(rootDir, 'out');
    const sourceDir = join(outDir, 'windows-x64');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'mangostudio.exe'), 'hub binary');
    writeFileSync(join(sourceDir, 'mangostudio-runtime.exe'), 'runtime binary');
    writeFileSync(join(outDir, 'README.md'), '# Standalone build\n');
    stageFrontendDist(rootDir);
    mkdirSync(join(rootDir, 'scripts', 'install'), { recursive: true });
    writeFileSync(join(rootDir, 'scripts', 'install', 'install.sh'), '#!/usr/bin/env bash\n');
    writeFileSync(join(rootDir, 'scripts', 'install', 'install.ps1'), '# fixture\n');
    const plan = createReleaseAssetPlan({
      version: '1.2.3',
      rootDir,
      outDir,
      assetsDir: join(rootDir, 'release-assets'),
      onlyPlatform: 'windows-x64',
    });
    await archiveReleaseAssets(plan);
    const [archive] = plan.platformArchives;
    if (!archive) throw new Error('expected a Windows platform archive | received: none');
    const destination = join(rootDir, '.mango', 'out', 'windows-x64');
    await extractTargetArchive({
      archivePath: archive.archivePath,
      archiveFormat: 'zip',
      destination,
      expectedMembers: ['mangostudio.exe', 'mangostudio-runtime.exe', 'README.md'],
      rootDir,
    });
    expect(readFileSync(join(destination, 'mangostudio.exe'), 'utf8')).toBe('hub binary');
    expect(readFileSync(join(destination, 'mangostudio-runtime.exe'), 'utf8')).toBe(
      'runtime binary'
    );
    expect(readFileSync(join(destination, 'README.md'), 'utf8')).toBe('# Standalone build\n');
    const digest = createHash('sha256').update(readFileSync(archive.archivePath)).digest('hex');
    expect(readFileSync(plan.checksumPath, 'utf8')).toContain(`${digest}  ${archive.assetName}\n`);
  });
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

  test('names the earlier build step when the README was never written', async () => {
    const rootDir = makeTempDir();
    const outDir = join(rootDir, 'out');
    stageFailedVerificationBuild(outDir, 'linux-x64');
    const plan = createReleaseAssetPlan({
      version: '1.2.3',
      rootDir,
      outDir,
      assetsDir: join(rootDir, 'release-assets'),
      onlyPlatform: 'linux-x64',
    });

    const message = await archiveReleaseAssets(plan).then(
      () => 'archived a build that never finished',
      (caught: unknown) => (caught instanceof Error ? caught.message : String(caught))
    );

    expect(message, 'message must name the missing file').toContain(join(outDir, 'README.md'));
    expect(
      message,
      `expected a message naming the failed build step | received: ${message}`
    ).toContain('bun run build --binary');
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
    const frontendMembers = (await openTarArchive(plan.frontendArchive.archivePath)).entries.join(
      '\n'
    );
    expect(frontendMembers).toContain('./index.html');
    expect(frontendMembers).not.toContain(BUILD_STATE_FILE);
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

  test('copies the install scripts verbatim and checksums them', async () => {
    const rootDir = makeTempDir();
    const arches = ['linux-x64-musl'] as const;
    stageMuslPlatforms(join(rootDir, 'out'), arches);
    stageFrontendDist(rootDir);
    mkdirSync(join(rootDir, 'scripts', 'install'), { recursive: true });
    writeFileSync(
      join(rootDir, 'scripts', 'install', 'install.sh'),
      '#!/usr/bin/env bash\necho fixture\n'
    );
    writeFileSync(join(rootDir, 'scripts', 'install', 'install.ps1'), '# fixture\n');

    const plan = createReleaseAssetPlan({
      version: '1.2.3',
      rootDir,
      outDir: join(rootDir, 'out'),
      assetsDir: join(rootDir, 'release-assets'),
      onlyPlatform: 'linux-x64-musl',
    });

    await archiveReleaseAssets(plan);

    for (const script of plan.installerScripts) {
      expect(existsSync(script.assetPath)).toBe(true);
      expect(readFileSync(script.assetPath, 'utf8')).toBe(readFileSync(script.sourcePath, 'utf8'));
    }
    const checksumLines = readFileSync(plan.checksumPath, 'utf8').trimEnd().split('\n');
    expect(checksumLines.some((line) => line.endsWith('  install.sh'))).toBe(true);
    expect(checksumLines.some((line) => line.endsWith('  install.ps1'))).toBe(true);
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
