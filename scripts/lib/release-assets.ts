// Pure release asset planning. The executable script performs filesystem work;
// this module keeps asset names and layouts testable without creating archives.

import { join } from 'node:path';

import { ROOT_DIR } from './config';
import {
  type BinaryTarget,
  filterBinaryTargets,
  platformArchiveLayout,
  releaseArchiveFileName,
  releaseRawHubBinaryFileName,
  releaseRawRuntimeBinaryFileName,
  runtimeBinaryName,
} from './release-targets';

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
  /** Execution host spawned for stdio environments; ships beside the hub binary. */
  readonly runtimeBinaryPath: string;
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

/** Uncompressed hub or runtime binary copied beside the platform archive. */
interface RawBinaryAssetPlan {
  readonly sourcePath: string;
  readonly assetName: string;
  readonly assetPath: string;
  /** Release platform id (`target.arch`) this binary was compiled for. */
  readonly platform: string;
  /**
   * Which half of the platform's pair this is. The handshake refuses a version
   * mismatch, so a hub published without its runtime is not a partial release —
   * it is a broken one, and selection code has to be able to say which is which.
   */
  readonly kind: 'hub' | 'runtime';
}

export interface ReleaseAssetPlan {
  readonly rootDir: string;
  readonly outDir: string;
  readonly assetsDir: string;
  readonly platformArchives: readonly PlatformArchivePlan[];
  readonly rawBinaries: readonly RawBinaryAssetPlan[];
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
  const rawBinaries = platformArchives.flatMap((archive) =>
    createRawBinaryPlans(archive, options.version, assetsDir)
  );
  const frontendArchive = createFrontendArchivePlan(rootDir, options.version, assetsDir);
  const checksummedAssetPaths = [
    ...platformArchives.map((asset) => asset.archivePath),
    ...rawBinaries.map((asset) => asset.assetPath),
    frontendArchive.archivePath,
  ];

  return {
    rootDir,
    outDir,
    assetsDir,
    platformArchives,
    rawBinaries,
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
    runtimeBinaryPath: join(sourceDir, runtimeBinaryName(target.name)),
    cursorSidecarDir: join(sourceDir, 'cursor-sidecar'),
    readmePath: join(outDir, 'README.md'),
    assetName,
    archivePath: join(assetsDir, assetName),
  };
}

function createRawBinaryPlans(
  archive: PlatformArchivePlan,
  version: string,
  assetsDir: string
): readonly RawBinaryAssetPlan[] {
  const hubName = releaseRawHubBinaryFileName(version, archive.platform);
  const runtimeName = releaseRawRuntimeBinaryFileName(version, archive.platform);
  return [
    {
      sourcePath: archive.binaryPath,
      assetName: hubName,
      assetPath: join(assetsDir, hubName),
      platform: archive.platform.arch,
      kind: 'hub',
    },
    {
      sourcePath: archive.runtimeBinaryPath,
      assetName: runtimeName,
      assetPath: join(assetsDir, runtimeName),
      platform: archive.platform.arch,
      kind: 'runtime',
    },
  ];
}

/**
 * Platforms whose raw hub+runtime pair the rolling canary publishes.
 *
 * A default, not a constant — widening it is a one-line config change. What it
 * must never do is widen by accident, which is why the canary staging step
 * names its assets from this list instead of globbing the release plan.
 *
 * `linux-arm64` is deliberately absent: ARM Linux users are on stable, and the
 * pair costs roughly 190 MB per green commit to serve nobody. Stable publishes
 * the full matrix and is one `mangostudio update` away.
 */
export const CANARY_PAIR_PLATFORMS: readonly string[] = [
  'linux-x64',
  'darwin-arm64',
  'windows-x64',
];

export interface CanaryAssetSelection {
  /**
   * Every platform archive plus the frontend archive, unchanged. The Cargo
   * launcher resolves `mangostudio-<version>-<platform>.<ext>` for whatever
   * host it was built for (`packages/cargo-shim/src/main.rs`), so narrowing
   * archives to the curated platforms would strand canary launchers on the
   * other five.
   */
  readonly archives: readonly string[];
  /** Raw hub+runtime pairs, curated to {@link CANARY_PAIR_PLATFORMS}. */
  readonly rawBinaries: readonly string[];
}

/**
 * The exact asset names the rolling canary pre-release publishes.
 *
 * Explicit selection rather than a shell glob: `release-assets/mangostudio-*`
 * silently absorbed the eight raw hub binaries the moment raw assets shipped,
 * while never matching a single raw runtime binary — canary paid the upload
 * cost and got none of the benefit. Naming the assets here means a new asset
 * type added to the release plan cannot change what canary uploads without
 * also changing this function and the test that pins it.
 * // Usage: selectCanaryAssets(createReleaseAssetPlan({ version }))
 */
export function selectCanaryAssets(
  plan: ReleaseAssetPlan,
  platforms: readonly string[] = CANARY_PAIR_PLATFORMS
): CanaryAssetSelection {
  const rawBinaries: string[] = [];
  for (const platform of platforms) {
    const pair = plan.rawBinaries.filter((asset) => asset.platform === platform);
    const hub = pair.find((asset) => asset.kind === 'hub');
    const runtime = pair.find((asset) => asset.kind === 'runtime');
    // Half a pair is a handshake refusal on somebody's machine, so a platform
    // that cannot contribute both contributes neither — loudly, here, rather
    // than as a failed upgrade later.
    if (!hub || !runtime) {
      throw new Error(
        `Canary platform ${platform} has no complete hub+runtime pair in the release plan.`
      );
    }
    rawBinaries.push(hub.assetName, runtime.assetName);
  }

  return {
    archives: [
      ...plan.platformArchives.map((archive) => archive.assetName),
      plan.frontendArchive.assetName,
    ],
    rawBinaries,
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
  return platformArchiveLayout(plan.platform.name, options).sourceDirMembers;
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
