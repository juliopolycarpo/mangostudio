#!/usr/bin/env bun
// Assemble the GitHub Release asset set with stable names and flat archive roots.

import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { BUILD_STATE_FILE } from '@mangostudio/shared/utils/dist-files';
import { ROOT_DIR } from '../lib/config';
import { archiveConcurrency, captureCommand, mapWithConcurrency } from '../lib/exec';
import { assertDirectory, assertFile, assertSafeToDelete } from '../lib/fs-assert';
import {
  createReleaseAssetPlan,
  type FrontendArchivePlan,
  type InstallerScriptPlan,
  type PlatformArchivePlan,
  platformArchiveMembers,
  type ReleaseAssetPlan,
} from '../lib/release-assets';
import { runtimeBinaryName } from '../lib/release-targets';
import { resolveReleaseVersion } from '../lib/release-version';
import { assertNoUnexpectedArguments, error, header, parseArgs, success } from '../lib/runner';

const printHelp = (): never => {
  console.log(`Usage: bun ./scripts/release/archive-assets.ts [--platform <target>]

Creates release-assets/ with platform archives, raw hub and runtime binaries,
frontend dist, and SHA256SUMS.

Flags:
  --platform <id>  Limit platform archives to one target (example: linux-x64)
  --help           Show this help message`);
  process.exit(0);
};

/** Create every release asset described by the plan. // Usage: await archiveReleaseAssets(plan) */
export async function archiveReleaseAssets(plan: ReleaseAssetPlan): Promise<void> {
  prepareAssetsDir(plan.assetsDir);

  const concurrency = archiveConcurrency();
  await mapWithConcurrency(plan.platformArchives, concurrency, (archive) =>
    archivePlatform(archive, plan.assetsDir)
  );
  copyRawAssets(plan);
  copyInstallerScripts(plan);
  await archiveFrontend(plan.frontendArchive);
  writeChecksumManifest(plan);
}

/** Copy install.sh and install.ps1 verbatim: they ship byte for byte, not rebuilt. */
function copyInstallerScripts(plan: ReleaseAssetPlan): void {
  for (const script of plan.installerScripts) {
    copyInstallerScript(script);
  }
}

function copyInstallerScript(script: InstallerScriptPlan): void {
  assertFile(script.sourcePath, script.assetName);
  cpSync(script.sourcePath, script.assetPath);
}

/**
 * Copy uncompressed hub and runtime binaries into release-assets/. No
 * compression: uploads already run at compression-level 0, so skipping gzip
 * adds no time to the sequential critical path.
 */
function copyRawAssets(plan: ReleaseAssetPlan): void {
  for (const asset of plan.rawBinaries) {
    assertFile(asset.sourcePath, asset.assetName);
    cpSync(asset.sourcePath, asset.assetPath);
  }
}

function prepareAssetsDir(assetsDir: string): void {
  assertSafeToDelete(assetsDir, {
    rootDir: ROOT_DIR,
    allowedOutsideRoots: [tmpdir()],
    label: 'release assets directory',
  });

  rmSync(assetsDir, { force: true, recursive: true });
  mkdirSync(assetsDir, { recursive: true });
}

/**
 * Both branches shell out, for the same reason: `Bun.Archive` writes every entry
 * `0644` and exposes no mode option, so a natively created archive would ship
 * non-executable binaries. `test-build.ts` asserts the executable bit, the
 * Homebrew formula installs the archive contents without a chmod, and anyone
 * who untars a release by hand expects to run what falls out. It writes tar
 * only in any case, so the zip half could never convert.
 * Reading is native — see `scripts/lib/archive.ts` and `docs/reference/tooling.md`.
 */
async function archivePlatform(plan: PlatformArchivePlan, assetsDir: string): Promise<void> {
  assertPlatformInputs(plan);

  if (plan.platform.archiveFormat === 'zip') {
    await archivePlatformZip(plan, assetsDir);
    return;
  }

  const members = platformArchiveMembers(plan);

  await runCommand([
    'tar',
    '-czf',
    plan.archivePath,
    '-C',
    plan.sourceDir,
    ...members,
    '-C',
    dirname(plan.readmePath),
    'README.md',
  ]);
}

async function archivePlatformZip(plan: PlatformArchivePlan, assetsDir: string): Promise<void> {
  const stagingDir = join(assetsDir, '.staging', plan.platform.arch);
  rmSync(stagingDir, { force: true, recursive: true });
  mkdirSync(stagingDir, { recursive: true });

  cpSync(plan.binaryPath, join(stagingDir, plan.platform.name));
  cpSync(plan.runtimeBinaryPath, join(stagingDir, runtimeBinaryName(plan.platform.name)));
  cpSync(plan.readmePath, join(stagingDir, 'README.md'));

  const members = platformArchiveMembers(plan);

  await runCommand(['zip', '-qr', plan.archivePath, ...members, 'README.md'], stagingDir);
  rmSync(stagingDir, { force: true, recursive: true });
}

/**
 * Tar the built frontend, minus the build stamp.
 *
 * This archive is the whole `dist/` directory, so it picks up anything a build
 * leaves there — and `build.ts` leaves `BUILD_STATE_FILE`, which exists to tell
 * the *dev server* whether its own bundle is stale. It means nothing to whoever
 * untars a release, and the API serves the directory it is unpacked into.
 * `--exclude` goes ahead of `-C` because bsdtar applies it only to the operands
 * that follow, and the pattern is unanchored — no `./` prefix — so it matches
 * the same member under both tars. The release pipeline runs on ubuntu, so GNU
 * tar is what CI exercises; the portable spelling is for anyone who runs this
 * script on a mac.
 */
async function archiveFrontend(plan: FrontendArchivePlan): Promise<void> {
  assertDirectory(join(plan.sourceDir, 'assets'), 'frontend assets directory');
  assertFile(join(plan.sourceDir, 'index.html'), 'frontend index.html');
  await runCommand([
    'tar',
    '-czf',
    plan.archivePath,
    `--exclude=${BUILD_STATE_FILE}`,
    '-C',
    plan.sourceDir,
    '.',
  ]);
}

function assertPlatformInputs(plan: PlatformArchivePlan): void {
  assertFile(plan.binaryPath, `${plan.platform.arch} binary`);
  assertFile(plan.runtimeBinaryPath, `${plan.platform.arch} runtime binary`);
  assertFile(plan.readmePath, 'standalone README.md');
}

function writeChecksumManifest(plan: ReleaseAssetPlan): void {
  // Format contract is pinned by scripts/tests/support/SHA256SUMS.sample and
  // consumed by verify-checksum.ts, cargo-shim, and the mangostudio.dev install scripts.
  const lines = plan.checksummedAssetPaths.map((assetPath) => {
    assertFile(assetPath, basename(assetPath));
    return `${sha256File(assetPath)}  ${basename(assetPath)}`;
  });
  writeFileSync(plan.checksumPath, `${lines.join('\n')}\n`);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function runCommand(cmd: string[], cwd?: string): Promise<void> {
  const { stdout, stderr, exitCode } = await captureCommand(cmd, { cwd });
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${cmd.join(' ')}\n${stderr || stdout}`);
  }
}

async function main(): Promise<void> {
  const { flags, values, positional } = parseArgs({ valueFlags: ['--platform'] });
  if (flags['--help']) printHelp();
  assertNoUnexpectedArguments(positional);

  const version = resolveReleaseVersion();
  const plan = createReleaseAssetPlan({ version, onlyPlatform: values['--platform'] });
  header('Archive release assets');
  await archiveReleaseAssets(plan);
  success(`Release assets written to ${plan.assetsDir}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  }
}
