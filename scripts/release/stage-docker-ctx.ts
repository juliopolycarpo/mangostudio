#!/usr/bin/env bun

import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_DIR } from '../lib/config';
import {
  createDockerStagePlan,
  type DockerStagePlan,
  type DockerStageTarget,
  dockerReleaseAssetName,
  parseDockerArchFilter,
  parseDockerVariantFilter,
} from '../lib/docker-stage';
import { assertFile, assertSafeToDelete } from '../lib/fs-assert';
import { resolveReleaseVersion } from '../lib/release-version';
import {
  assertNoUnexpectedArguments,
  captureCommand,
  error,
  header,
  parseArgs,
  success,
} from '../lib/runner';

interface StageOptions {
  readonly releaseAssetsDir?: string;
}

function printHelp(): never {
  console.log(`Usage: bun ./scripts/release/stage-docker-ctx.ts [--arch <amd64|arm64|all>] [--variant <bookworm|alpine|all>]

Stages standalone binaries into docker-ctx/ for Docker buildx.

Flags:
  --arch <arch>          Stage one Docker TARGETARCH value (default: all)
  --variant <variant>    Stage one image variant (default: all)
  --context-dir <path>   Override output directory (default: docker-ctx)
  --release-assets <dir> Stage from release tarballs instead of .mango/out
  --help                 Show this help message`);
  process.exit(0);
}

/** Stage all Docker image inputs described by a plan. // Usage: await stageDockerContext(plan) */
export async function stageDockerContext(
  plan: DockerStagePlan,
  options: StageOptions = {}
): Promise<void> {
  prepareContextDir(plan.contextDir);

  const releaseAssetsDir = options.releaseAssetsDir;
  const releaseVersion = releaseAssetsDir ? resolveReleaseVersion() : undefined;

  for (const target of plan.targets) {
    if (releaseAssetsDir && releaseVersion) {
      await stageFromReleaseAsset(target, releaseAssetsDir, releaseVersion);
    } else {
      stageFromBuildOutput(target);
    }
  }
}

function prepareContextDir(contextDir: string): void {
  // Deletes are limited to docker-ctx under the repo or an explicit temp override.
  assertSafeToDelete(contextDir, {
    rootDir: ROOT_DIR,
    allowedOutsideRoots: [tmpdir()],
    label: 'Docker context',
  });

  rmSync(contextDir, { force: true, recursive: true });
  mkdirSync(contextDir, { recursive: true });
}

function stageFromBuildOutput(target: DockerStageTarget): void {
  copyTarget(target, target.binaryPath);
}

async function stageFromReleaseAsset(
  target: DockerStageTarget,
  releaseAssetsDir: string,
  version: string
): Promise<void> {
  const archivePath = join(
    releaseAssetsDir,
    dockerReleaseAssetName(version, target.dockerVariant, target.dockerArch)
  );
  assertFile(archivePath, `${target.dockerVariant}/${target.platform.arch} release archive`);

  const extractDir = mkdtempSync(
    join(tmpdir(), `mangostudio-docker-${target.dockerVariant}-${target.dockerArch}-`)
  );
  try {
    await runCommand(['tar', '-xzf', archivePath, '-C', extractDir]);
    copyTarget(target, join(extractDir, target.platform.name));
  } finally {
    rmSync(extractDir, { force: true, recursive: true });
  }
}

function copyTarget(target: DockerStageTarget, binaryPath: string): void {
  assertFile(binaryPath, `${target.platform.arch} binary`);

  rmSync(target.contextArchDir, { force: true, recursive: true });
  mkdirSync(target.contextArchDir, { recursive: true });
  cpSync(binaryPath, target.stagedBinaryPath);
  chmodSync(target.stagedBinaryPath, 0o755);
}

async function runCommand(cmd: string[]): Promise<void> {
  const { stdout, stderr, exitCode } = await captureCommand(cmd);
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${cmd.join(' ')}\n${stderr || stdout}`);
  }
}

async function main(): Promise<void> {
  const { flags, values, positional } = parseArgs({
    valueFlags: ['--arch', '--variant', '--context-dir', '--release-assets'],
  });
  if (flags['--help']) printHelp();
  assertNoUnexpectedArguments(positional);

  const onlyArch = parseDockerArchFilter(values['--arch']);
  const onlyVariant = parseDockerVariantFilter(values['--variant']);
  const plan = createDockerStagePlan({
    rootDir: ROOT_DIR,
    contextDir: values['--context-dir'],
    onlyArch,
    onlyVariant,
  });

  header('Stage Docker context');
  await stageDockerContext(plan, { releaseAssetsDir: values['--release-assets'] });
  success(`Docker context written to ${plan.contextDir}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  }
}
