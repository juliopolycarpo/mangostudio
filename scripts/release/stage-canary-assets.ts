#!/usr/bin/env bun
// Stage the rolling canary pre-release asset set: every platform archive plus a
// curated set of raw hub+runtime pairs, renamed onto the rolling version.

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { assertFile, assertSafeToDelete } from '../lib/fs-assert';
import {
  CANARY_PAIR_PLATFORMS,
  createReleaseAssetPlan,
  selectCanaryAssets,
} from '../lib/release-assets';
import {
  assertNoUnexpectedArguments,
  error,
  header,
  info,
  parseArgs,
  requiredEnv,
  success,
} from '../lib/runner';

/** Names the provenance of one rolling build; see `canary-manifest.json` below. */
const MANIFEST_NAME = 'canary-manifest.json';
const MANIFEST_SCHEMA_VERSION = 1;

const printHelp = (): never => {
  console.log(`Usage: bun ./scripts/release/stage-canary-assets.ts [flags]

Copies the canary asset set out of the built release assets, renaming the build
version onto the rolling version, and writes ${MANIFEST_NAME} plus SHA256SUMS.

Flags:
  --version <v>        Built canary version (default: $VERSION)
  --cargo-version <v>  Rolling version the assets are published under (default: $CARGO_VERSION)
  --source-sha <sha>   Commit the build came from (default: $SOURCE_SHA)
  --in <dir>           Built release assets (default: release-assets)
  --out <dir>          Staging directory to write (default: github-canary-assets)
  --help               Show this help message`);
  process.exit(0);
};

interface PairAsset {
  readonly asset: string;
  readonly digest: string;
}

interface CanaryManifest {
  readonly schemaVersion: number;
  readonly channel: 'canary';
  /** The version the binaries report about themselves, sha included. */
  readonly version: string;
  /** The version their filenames and tag carry. */
  readonly assetVersion: string;
  readonly sourceSha: string;
  readonly builtAt: string;
  readonly pairs: readonly {
    readonly platform: string;
    readonly hub: PairAsset;
    readonly runtime: PairAsset;
  }[];
}

export interface StageCanaryAssetsOptions {
  readonly version: string;
  readonly cargoVersion: string;
  readonly sourceSha: string;
  readonly inDir: string;
  readonly outDir: string;
  readonly builtAt?: string;
}

/**
 * Stage the rolling asset set and return the names written.
 *
 * Assets are renamed rather than rebuilt: the binaries were compiled with the
 * sha-stamped version and report it, while their filenames and tag carry the
 * rolling one. That gap is exactly why {@link MANIFEST_NAME} exists — it is the
 * only thing on the release that says which commit these bytes came from.
 */
export function stageCanaryAssets(options: StageCanaryAssetsOptions): readonly string[] {
  const { version, cargoVersion, sourceSha, inDir, outDir } = options;
  const plan = createReleaseAssetPlan({ version, assetsDir: inDir });
  const selection = selectCanaryAssets(plan);

  prepareOutDir(outDir);

  const staged: string[] = [];
  for (const assetName of [...selection.archives, ...selection.rawBinaries]) {
    staged.push(stageOne(assetName, { version, cargoVersion, inDir, outDir }));
  }

  const manifest = buildManifest({
    plan,
    selection,
    version,
    cargoVersion,
    sourceSha,
    builtAt: options.builtAt ?? new Date().toISOString(),
    outDir,
  });
  writeFileSync(join(outDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  staged.push(MANIFEST_NAME);

  // The manifest is checksummed like every other asset: a provenance record
  // nobody can verify is decoration.
  writeChecksums(outDir, staged);
  return staged;
}

function stageOne(
  assetName: string,
  context: {
    readonly version: string;
    readonly cargoVersion: string;
    readonly inDir: string;
    readonly outDir: string;
  }
): string {
  const source = join(context.inDir, assetName);
  assertFile(source, assetName);
  const target = rollingAssetName(assetName, context.version, context.cargoVersion);
  copyFileSync(source, join(context.outDir, target));
  return target;
}

/**
 * Swap the built version for the rolling one in an asset name.
 *
 * Anchored on the `mangostudio-` / `mangostudio-runtime-` prefix rather than a
 * bare substring replace: a version string can appear inside a platform id in
 * principle, and a filename is not the place to find out.
 */
export function rollingAssetName(assetName: string, version: string, cargoVersion: string): string {
  for (const prefix of ['mangostudio-runtime-', 'mangostudio-']) {
    const head = `${prefix}${version}`;
    if (assetName.startsWith(head)) {
      return `${prefix}${cargoVersion}${assetName.slice(head.length)}`;
    }
  }
  throw new Error(`Canary asset ${assetName} does not carry version ${version}.`);
}

function buildManifest(context: {
  readonly plan: ReturnType<typeof createReleaseAssetPlan>;
  readonly selection: ReturnType<typeof selectCanaryAssets>;
  readonly version: string;
  readonly cargoVersion: string;
  readonly sourceSha: string;
  readonly builtAt: string;
  readonly outDir: string;
}): CanaryManifest {
  const pairs = CANARY_PAIR_PLATFORMS.map((platform) => {
    const forPlatform = context.plan.rawBinaries.filter((asset) => asset.platform === platform);
    const named = (kind: 'hub' | 'runtime'): PairAsset => {
      const asset = forPlatform.find((candidate) => candidate.kind === kind);
      if (!asset) throw new Error(`Canary platform ${platform} is missing its ${kind} binary.`);
      const staged = rollingAssetName(asset.assetName, context.version, context.cargoVersion);
      return { asset: staged, digest: sha256File(join(context.outDir, staged)) };
    };
    return { platform, hub: named('hub'), runtime: named('runtime') };
  });

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    channel: 'canary',
    version: context.version,
    assetVersion: context.cargoVersion,
    sourceSha: context.sourceSha,
    builtAt: context.builtAt,
    pairs,
  };
}

function prepareOutDir(outDir: string): void {
  assertSafeToDelete(outDir, {
    rootDir: ROOT_DIR,
    allowedOutsideRoots: [tmpdir()],
    label: 'canary staging directory',
  });
  rmSync(outDir, { force: true, recursive: true });
  mkdirSync(outDir, { recursive: true });
}

/**
 * Same manifest format the release job publishes — install.sh, the cargo shim
 * and verify-checksum.ts all parse it, so the shape is a pinned contract.
 */
function writeChecksums(outDir: string, assetNames: readonly string[]): void {
  const lines = [...assetNames]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `${sha256File(join(outDir, name))}  ${name}`);
  writeFileSync(join(outDir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function main(): void {
  const { flags, values, positional } = parseArgs({
    valueFlags: ['--version', '--cargo-version', '--source-sha', '--in', '--out'],
  });
  if (flags['--help']) printHelp();
  assertNoUnexpectedArguments(positional);

  const version = values['--version'] ?? requiredEnv('VERSION');
  const cargoVersion = values['--cargo-version'] ?? requiredEnv('CARGO_VERSION');
  const sourceSha = values['--source-sha'] ?? requiredEnv('SOURCE_SHA');
  const inDir = values['--in'] ?? join(ROOT_DIR, 'release-assets');
  const outDir = values['--out'] ?? join(ROOT_DIR, 'github-canary-assets');

  header('Stage canary release assets');
  const staged = stageCanaryAssets({ version, cargoVersion, sourceSha, inDir, outDir });
  info(`Curated raw pairs: ${CANARY_PAIR_PLATFORMS.join(', ')}`);
  success(`Staged ${staged.length} assets (plus SHA256SUMS) in ${outDir}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  }
}
