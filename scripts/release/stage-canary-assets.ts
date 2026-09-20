#!/usr/bin/env bun
// Stage one canary pre-release's asset set: every platform archive plus a
// curated set of raw hub+runtime pairs, under their built sha-stamped names.

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

/** Names the provenance of one canary build; see `canary-manifest.json` below. */
const MANIFEST_NAME = 'canary-manifest.json';
const MANIFEST_SCHEMA_VERSION = 1;

const printHelp = (): never => {
  console.log(`Usage: bun ./scripts/release/stage-canary-assets.ts [flags]

Copies the canary asset set out of the built release assets and writes
${MANIFEST_NAME} plus SHA256SUMS.

Flags:
  --version <v>        Built canary version, tag and asset names (default: $VERSION)
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
  /**
   * The version their filenames and tag carry. Equal to {@link version} since
   * canary releases became per-commit; kept because the field is a published
   * schema the hub and the installers read.
   */
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
  readonly sourceSha: string;
  readonly inDir: string;
  readonly outDir: string;
  readonly builtAt?: string;
}

/**
 * Stage one canary release's asset set and return the names written.
 *
 * Names are the ones the build produced: the binaries were compiled with the
 * sha-stamped version, report it, and are published under a tag carrying it, so
 * the tag, the file names and {@link MANIFEST_NAME} all name the same build.
 * The manifest stays because it is the only asset that says which *commit*
 * those bytes came from.
 *
 * @example
 * stageCanaryAssets({ version: '0.1.1-canary.abc1234', sourceSha, inDir, outDir })
 */
export function stageCanaryAssets(options: StageCanaryAssetsOptions): readonly string[] {
  const { version, sourceSha, inDir, outDir } = options;
  const plan = createReleaseAssetPlan({ version, assetsDir: inDir });
  const selection = selectCanaryAssets(plan);

  prepareOutDir(outDir);

  const staged: string[] = [];
  for (const assetName of [...selection.archives, ...selection.rawBinaries, ...selection.scripts]) {
    staged.push(stageAsset(assetName, { inDir, outDir }));
  }

  const manifest = buildManifest({
    plan,
    selection,
    version,
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

/** Copies one built asset into the staging directory under its own name. */
function stageAsset(
  assetName: string,
  context: { readonly inDir: string; readonly outDir: string }
): string {
  const source = join(context.inDir, assetName);
  assertFile(source, assetName);
  copyFileSync(source, join(context.outDir, assetName));
  return assetName;
}

function buildManifest(context: {
  readonly plan: ReturnType<typeof createReleaseAssetPlan>;
  readonly selection: ReturnType<typeof selectCanaryAssets>;
  readonly version: string;
  readonly sourceSha: string;
  readonly builtAt: string;
  readonly outDir: string;
}): CanaryManifest {
  const pairs = CANARY_PAIR_PLATFORMS.map((platform) => {
    const forPlatform = context.plan.rawBinaries.filter((asset) => asset.platform === platform);
    const named = (kind: 'hub' | 'runtime'): PairAsset => {
      const asset = forPlatform.find((candidate) => candidate.kind === kind);
      if (!asset) throw new Error(`Canary platform ${platform} is missing its ${kind} binary.`);
      return {
        asset: asset.assetName,
        digest: sha256File(join(context.outDir, asset.assetName)),
      };
    };
    return { platform, hub: named('hub'), runtime: named('runtime') };
  });

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    channel: 'canary',
    version: context.version,
    assetVersion: context.version,
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
 * Same manifest format the release job publishes — install.sh, the Cargo launcher
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
    valueFlags: ['--version', '--source-sha', '--in', '--out'],
  });
  if (flags['--help']) printHelp();
  assertNoUnexpectedArguments(positional);

  const version = values['--version'] ?? requiredEnv('VERSION');
  const sourceSha = values['--source-sha'] ?? requiredEnv('SOURCE_SHA');
  const inDir = values['--in'] ?? join(ROOT_DIR, 'release-assets');
  const outDir = values['--out'] ?? join(ROOT_DIR, 'github-canary-assets');

  header('Stage canary release assets');
  const staged = stageCanaryAssets({ version, sourceSha, inDir, outDir });
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
