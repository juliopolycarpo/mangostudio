#!/usr/bin/env bun
// Assemble the GitHub Release asset set with stable names and flat archive roots.

import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  createReleaseAssetPlan,
  type FrontendArchivePlan,
  type InstallerAssetPlan,
  type PlatformArchivePlan,
  type ReleaseAssetPlan,
} from '../lib/release-assets';
import { resolveReleaseVersion } from '../lib/release-version';
import {
  assertNoUnexpectedArguments,
  captureCommand,
  error,
  header,
  parseArgs,
  success,
} from '../lib/runner';

const printHelp = (): never => {
  console.log(`Usage: bun ./scripts/release/archive-assets.ts [--platform <target>]

Creates release-assets/ with platform archives, frontend dist, installers, and SHA256SUMS.

Flags:
  --platform <id>  Limit platform archives to one target (example: linux-x64)
  --help           Show this help message`);
  process.exit(0);
};

/** Create every release asset described by the plan. // Usage: await archiveReleaseAssets(plan) */
export async function archiveReleaseAssets(plan: ReleaseAssetPlan): Promise<void> {
  prepareAssetsDir(plan.assetsDir);

  for (const archive of plan.platformArchives) {
    await archivePlatform(archive, plan.assetsDir);
  }

  await archiveFrontend(plan.frontendArchive);
  copyInstallers(plan.installerAssets);
  writeChecksumManifest(plan);
}

function prepareAssetsDir(assetsDir: string): void {
  rmSync(assetsDir, { force: true, recursive: true });
  mkdirSync(assetsDir, { recursive: true });
}

async function archivePlatform(plan: PlatformArchivePlan, assetsDir: string): Promise<void> {
  assertPlatformInputs(plan);

  if (plan.platform.archiveFormat === 'zip') {
    await archivePlatformZip(plan, assetsDir);
    return;
  }

  await runCommand([
    'tar',
    '-czf',
    plan.archivePath,
    '-C',
    plan.sourceDir,
    plan.platform.name,
    'public',
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
  cpSync(plan.publicDir, join(stagingDir, 'public'), { recursive: true });
  cpSync(plan.readmePath, join(stagingDir, 'README.md'));

  await runCommand(
    ['zip', '-qr', plan.archivePath, plan.platform.name, 'public', 'README.md'],
    stagingDir
  );
  rmSync(stagingDir, { force: true, recursive: true });
}

async function archiveFrontend(plan: FrontendArchivePlan): Promise<void> {
  assertDirectory(join(plan.sourceDir, 'assets'), 'frontend assets directory');
  assertFile(join(plan.sourceDir, 'index.html'), 'frontend index.html');
  await runCommand(['tar', '-czf', plan.archivePath, '-C', plan.sourceDir, '.']);
}

function copyInstallers(installers: readonly InstallerAssetPlan[]): void {
  for (const installer of installers) {
    assertFile(installer.sourcePath, installer.assetName);
    cpSync(installer.sourcePath, installer.assetPath);
    if (installer.assetName === 'install.sh') {
      chmodSync(installer.assetPath, 0o755);
    }
  }
}

function assertPlatformInputs(plan: PlatformArchivePlan): void {
  assertFile(plan.binaryPath, `${plan.platform.arch} binary`);
  assertDirectory(plan.publicDir, `${plan.platform.arch} public directory`);
  assertFile(join(plan.publicDir, 'index.html'), `${plan.platform.arch} public/index.html`);
  assertFile(plan.readmePath, 'standalone README.md');
}

function assertDirectory(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`Missing ${label}: ${path}`);
  }
}

function assertFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Missing ${label}: ${path}`);
  }
}

function writeChecksumManifest(plan: ReleaseAssetPlan): void {
  // Format contract is pinned by scripts/tests/support/SHA256SUMS.sample and
  // consumed by verify-checksum.ts, cargo-shim, install.sh, and install.ps1.
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
