// Pure release asset planning. The executable script performs filesystem work;
// this module keeps asset names and layouts testable without creating archives.

import { join } from 'node:path';

import { ROOT_DIR } from './config';
import { type BinaryTarget, filterBinaryTargets, releaseArchiveFileName } from './release-targets';

export interface ReleaseAssetPlanOptions {
  readonly version: string;
  readonly rootDir?: string;
  readonly outDir?: string;
  readonly assetsDir?: string;
  readonly onlyPlatform?: string;
}

export interface PlatformArchivePlan {
  readonly platform: BinaryTarget;
  readonly sourceDir: string;
  readonly binaryPath: string;
  readonly publicDir: string;
  readonly readmePath: string;
  readonly assetName: string;
  readonly archivePath: string;
}

export interface FrontendArchivePlan {
  readonly sourceDir: string;
  readonly assetName: string;
  readonly archivePath: string;
}

export interface InstallerAssetPlan {
  readonly sourcePath: string;
  readonly assetName: string;
  readonly assetPath: string;
}

export interface ReleaseAssetPlan {
  readonly rootDir: string;
  readonly outDir: string;
  readonly assetsDir: string;
  readonly platformArchives: readonly PlatformArchivePlan[];
  readonly frontendArchive: FrontendArchivePlan;
  readonly installerAssets: readonly InstallerAssetPlan[];
  readonly checksummedAssetPaths: readonly string[];
  readonly checksumPath: string;
}

/** Create the canonical release asset plan for a version and optional platform. // Usage: createReleaseAssetPlan({ version: '1.2.3' }) */
export function createReleaseAssetPlan(options: ReleaseAssetPlanOptions): ReleaseAssetPlan {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const outDir = options.outDir ?? join(rootDir, '.mango', 'out');
  const assetsDir = options.assetsDir ?? join(rootDir, 'release-assets');
  const targets = filterBinaryTargets(options.onlyPlatform);

  if (targets.length === 0) {
    throw new Error(`No release platform matches filter: ${options.onlyPlatform}`);
  }

  const platformArchives = targets.map((target) =>
    createPlatformArchivePlan(target, options.version, outDir, assetsDir)
  );
  const frontendArchive = createFrontendArchivePlan(rootDir, options.version, assetsDir);
  const installerAssets = createInstallerAssetPlans(rootDir, assetsDir);
  const checksummedAssetPaths = [
    ...platformArchives.map((asset) => asset.archivePath),
    frontendArchive.archivePath,
    ...installerAssets.map((asset) => asset.assetPath),
  ];

  return {
    rootDir,
    outDir,
    assetsDir,
    platformArchives,
    frontendArchive,
    installerAssets,
    checksummedAssetPaths,
    checksumPath: join(assetsDir, 'SHA256SUMS'),
  };
}

function createPlatformArchivePlan(
  target: BinaryTarget,
  version: string,
  outDir: string,
  assetsDir: string
): PlatformArchivePlan {
  const sourceDir = join(outDir, target.arch);
  const assetName = releaseArchiveFileName(version, target);
  return {
    platform: target,
    sourceDir,
    binaryPath: join(sourceDir, target.name),
    publicDir: join(sourceDir, 'public'),
    readmePath: join(outDir, 'README.md'),
    assetName,
    archivePath: join(assetsDir, assetName),
  };
}

function createFrontendArchivePlan(
  rootDir: string,
  version: string,
  assetsDir: string
): FrontendArchivePlan {
  const assetName = `mangostudio-${version}-frontend-dist.tar.gz`;
  return {
    sourceDir: join(rootDir, 'apps', 'frontend', 'dist'),
    assetName,
    archivePath: join(assetsDir, assetName),
  };
}

function createInstallerAssetPlans(rootDir: string, assetsDir: string): InstallerAssetPlan[] {
  return ['install.sh', 'install.ps1'].map((assetName) => ({
    sourcePath: join(rootDir, 'scripts', 'install', assetName),
    assetName,
    assetPath: join(assetsDir, assetName),
  }));
}
