#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import {
  assertSafeDistributionArchiveEntries,
  DISTRIBUTION_MANIFEST_FILE,
  readDistributionManifest,
} from '../lib/distribution-manifest';
import { type CaptureResult, captureCommand } from '../lib/exec';
import { assertSafeToDelete } from '../lib/fs-assert';
import { ALL_BINARY_TARGETS, releaseArchiveFileName } from '../lib/release-targets';
import { assertNoUnexpectedArguments, error, parseArgs, success } from '../lib/runner';

type CommandRunner = (command: string[]) => Promise<CaptureResult>;

interface ArchiveCommands {
  readonly list: readonly string[];
  readonly extract: readonly string[];
}

interface ExtractTargetArchiveOptions {
  readonly archivePath: string;
  readonly archiveFormat: 'tar.gz' | 'zip';
  readonly destination: string;
  readonly expectedMembers: readonly string[];
  readonly rootDir: string;
}

interface ExtractTargetArchiveDependencies {
  readonly runCommand?: CommandRunner;
  readonly unzipCommand?: string | null;
  readonly platform?: NodeJS.Platform;
}

export function targetArchiveCommands(
  archivePath: string,
  destination: string,
  archiveFormat: 'tar.gz' | 'zip',
  unzipCommand: string | null,
  platform: NodeJS.Platform = process.platform
): ArchiveCommands {
  if (archiveFormat === 'tar.gz') {
    const toTarPath = (path: string): string =>
      platform === 'win32' ? path.replaceAll('\\', '/') : path;
    const local = platform === 'win32' ? ['--force-local'] : [];
    return {
      list: ['tar', ...local, '-tzf', toTarPath(archivePath)],
      extract: ['tar', ...local, '-xzf', toTarPath(archivePath), '-C', toTarPath(destination)],
    };
  }

  if (unzipCommand) {
    const toUnzipPath = (path: string): string =>
      platform === 'win32' ? path.replaceAll('\\', '/') : path;
    return {
      list: [unzipCommand, '-Z1', toUnzipPath(archivePath)],
      extract: [unzipCommand, '-q', toUnzipPath(archivePath), '-d', toUnzipPath(destination)],
    };
  }

  const archive = powerShellLiteral(archivePath);
  const target = powerShellLiteral(destination);
  return {
    list: [
      'powershell',
      '-NoProfile',
      '-Command',
      [
        // Without Stop, a non-terminating cmdlet error still exits 0 and the
        // caller would treat a partial listing as the whole archive.
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        `$zip = [IO.Compression.ZipFile]::OpenRead('${archive}')`,
        // [Console] rather than the pipeline: PowerShell's formatter hard-wraps
        // emitted strings at the host buffer width, which would split deep
        // sidecar entry names into fragments the safety check cannot judge.
        'try { $zip.Entries | ForEach-Object { [Console]::Out.WriteLine($_.FullName) } } finally { $zip.Dispose() }',
      ].join('; '),
    ],
    extract: [
      'powershell',
      '-NoProfile',
      '-Command',
      `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath '${archive}' -DestinationPath '${target}' -Force`,
    ],
  };
}

export async function extractTargetArchive(
  options: ExtractTargetArchiveOptions,
  dependencies: ExtractTargetArchiveDependencies = {}
): Promise<void> {
  const runCommand = dependencies.runCommand ?? ((command) => captureCommand(command));
  const unzipCommand = resolveUnzipCommand(options.archiveFormat, dependencies.unzipCommand);
  // Only the listing half is used here; extraction always targets the staging
  // directory below, which cannot exist yet because nothing may be written
  // before the entries are judged safe.
  const { list: listCommand } = targetArchiveCommands(
    options.archivePath,
    options.destination,
    options.archiveFormat,
    unzipCommand,
    dependencies.platform
  );

  const listing = await runArchiveCommand('list', listCommand, runCommand);
  assertSafeDistributionArchiveEntries(listing.split(/\r?\n/).filter(Boolean));

  const outDir = resolve(options.destination, '..');
  assertSafeToDelete(options.destination, {
    rootDir: options.rootDir,
    label: 'materialized target directory',
  });
  mkdirSync(outDir, { recursive: true });
  const stagingDir = mkdtempSync(join(outDir, '.extract-'));
  assertSafeToDelete(stagingDir, {
    rootDir: options.rootDir,
    label: 'target extraction staging directory',
  });

  try {
    const stagedCommands = targetArchiveCommands(
      options.archivePath,
      stagingDir,
      options.archiveFormat,
      unzipCommand,
      dependencies.platform
    );
    await runArchiveCommand('extract', stagedCommands.extract, runCommand);
    assertMaterializedMembers(stagingDir, options.expectedMembers);

    rmSync(options.destination, { force: true, recursive: true });
    renameSync(stagingDir, options.destination);
  } finally {
    rmSync(stagingDir, { force: true, recursive: true });
  }
}

async function runArchiveCommand(
  operation: 'list' | 'extract',
  command: readonly string[],
  runCommand: CommandRunner
): Promise<string> {
  const result = await runCommand([...command]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to ${operation} target archive: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`
    );
  }
  return result.stdout;
}

function resolveUnzipCommand(
  archiveFormat: 'tar.gz' | 'zip',
  injected: string | null | undefined
): string | null {
  if (injected !== undefined) return injected;
  // Probed only for zip targets so the tar.gz majority never depends on a tool
  // it will not run.
  return archiveFormat === 'zip' ? Bun.which('unzip') : null;
}

function assertMaterializedMembers(destination: string, expectedMembers: readonly string[]): void {
  const actual = readdirSync(destination).sort();
  const expected = [...expectedMembers].sort();
  if (
    actual.length !== expected.length ||
    actual.some((member, index) => member !== expected[index])
  ) {
    throw new Error(
      `Target archive layout mismatch: expected ${expected.join(', ')}, got ${actual.join(', ')}`
    );
  }
}

function assertWorkspacePath(path: string, rootDir: string, label: string): void {
  const rel = relative(resolve(rootDir), resolve(path));
  // relative() returns an absolute path when the two sides share no root (a
  // different Windows drive), which no `..` prefix check would catch.
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes the workspace: ${path}`);
  }
}

function powerShellLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

async function main(): Promise<void> {
  const { positional, values } = parseArgs({ valueFlags: ['--target'] });
  assertNoUnexpectedArguments(positional);
  const targetId = values['--target'];
  if (!targetId) {
    throw new Error('Usage: bun ./scripts/release/extract-target.ts --target <target>');
  }
  const manifest = readDistributionManifest(join(ROOT_DIR, DISTRIBUTION_MANIFEST_FILE));
  const target = manifest.targets.find((candidate) => candidate.id === targetId);
  const platform = ALL_BINARY_TARGETS.find((candidate) => candidate.arch === targetId);
  if (!target || !platform) {
    throw new Error(`Distribution target is missing from manifest: ${targetId}`);
  }

  const expectedArchive = `release-assets/${releaseArchiveFileName(
    manifest.packageVersion,
    platform
  )}`;
  if (target.archive !== expectedArchive) {
    throw new Error(
      `Distribution target archive mismatch: expected ${expectedArchive}, got ${target.archive}`
    );
  }

  const archivePath = resolve(ROOT_DIR, target.archive);
  const destination = resolve(ROOT_DIR, '.mango', 'out', target.id);
  assertWorkspacePath(archivePath, ROOT_DIR, 'Distribution target archive');
  assertWorkspacePath(destination, ROOT_DIR, 'Materialized target directory');

  await extractTargetArchive({
    archivePath,
    archiveFormat: platform.archiveFormat,
    destination,
    expectedMembers: target.archiveMembers,
    rootDir: ROOT_DIR,
  });
  success(`Distribution target materialized at ${destination}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  }
}
