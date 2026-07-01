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
  /** Vendored Cursor SDK sidecar dir; only present for platforms with a native package. */
  readonly cursorSidecarDir: string;
  readonly readmePath: string;
  readonly assetName: string;
  readonly archivePath: string;
}

export interface FrontendArchivePlan {
  readonly sourceDir: string;
  readonly assetName: string;
  readonly archivePath: string;
}

export interface ReleaseAssetPlan {
  readonly rootDir: string;
  readonly outDir: string;
  readonly assetsDir: string;
  readonly platformArchives: readonly PlatformArchivePlan[];
  readonly frontendArchive: FrontendArchivePlan;
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
  const checksummedAssetPaths = [
    ...platformArchives.map((asset) => asset.archivePath),
    frontendArchive.archivePath,
  ];

  return {
    rootDir,
    outDir,
    assetsDir,
    platformArchives,
    frontendArchive,
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
    cursorSidecarDir: join(sourceDir, 'cursor-sidecar'),
    readmePath: join(outDir, 'README.md'),
    assetName,
    archivePath: join(assetsDir, assetName),
  };
}

/**
 * Archive members relative to a platform's build output dir. The release
 * archive script validates required Cursor sidecar assets before including
 * them for platforms with a native Cursor SDK package.
 * // Usage: platformArchiveMembers(plan, { includeCursorSidecar: true })
 */
export function platformArchiveMembers(
  plan: PlatformArchivePlan,
  options: { readonly includeCursorSidecar: boolean }
): string[] {
  const members = [plan.platform.name, 'public'];
  if (options.includeCursorSidecar) {
    members.push('cursor-sidecar');
  }
  return members;
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
