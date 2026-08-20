#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { type ArchiveReader, openTarArchive } from '../lib/archive';
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
  /** Zip only; the tar.gz half reads the archive in-process. */
  readonly runCommand?: CommandRunner;
  readonly unzipCommand?: string | null;
  readonly platform?: NodeJS.Platform;
}

/**
 * Commands for the zip half of the release lane. Only Windows targets ship zip
 * (`release-targets.ts`), and `Bun.Archive` reads tar only, so these two
 * archives keep the subprocess on both ends while every tar.gz is read
 * in-process.
 */
export function zipArchiveCommands(
  archivePath: string,
  destination: string,
  unzipCommand: string | null,
  platform: NodeJS.Platform = process.platform
): ArchiveCommands {
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
  const archive =
    options.archiveFormat === 'zip'
      ? await openZipArchive(options, dependencies)
      : await openTarArchive(options.archivePath);

  // Judged before anything is written; extraction below targets a staging
  // directory that cannot exist yet. The tar.gz listing covers file entries
  // only — `Bun.Archive` does not report symlinks — but extraction drops a
  // symlink pointing outside the destination and strips leading `..` segments,
  // and the layout check plus the manifest digests are the real backstop.
  assertSafeDistributionArchiveEntries(archive.entries);

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
    await archive.extract(stagingDir);
    assertMaterializedMembers(stagingDir, options.expectedMembers);

    rmSync(options.destination, { force: true, recursive: true });
    renameSync(stagingDir, options.destination);
  } finally {
    rmSync(stagingDir, { force: true, recursive: true });
  }
}

/** Present the subprocess-backed zip path as the same reader as the native one. */
async function openZipArchive(
  options: ExtractTargetArchiveOptions,
  dependencies: ExtractTargetArchiveDependencies
): Promise<ArchiveReader> {
  const runCommand = dependencies.runCommand ?? ((command) => captureCommand(command));
  const unzipCommand = resolveUnzipCommand(dependencies.unzipCommand);
  const platform = dependencies.platform;
  const listing = await runArchiveCommand(
    'list',
    zipArchiveCommands(options.archivePath, options.destination, unzipCommand, platform).list,
    runCommand
  );

  return {
    entries: listing.split(/\r?\n/).filter(Boolean),
    extract: async (destination: string): Promise<void> => {
      const { extract } = zipArchiveCommands(
        options.archivePath,
        destination,
        unzipCommand,
        platform
      );
      await runArchiveCommand('extract', extract, runCommand);
    },
  };
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

function resolveUnzipCommand(injected: string | null | undefined): string | null {
  // Reached only from the zip path, so the tar.gz majority never probes for a
  // tool it will not run.
  return injected === undefined ? Bun.which('unzip') : injected;
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
