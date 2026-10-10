#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { openTarArchive } from '../lib/archive';
import { ROOT_DIR } from '../lib/config';
import {
  assertSafeDistributionArchiveEntries,
  DISTRIBUTION_MANIFEST_FILE,
  readDistributionManifest,
} from '../lib/distribution-manifest';
import { assertSafeToDelete } from '../lib/fs-assert';
import { ALL_BINARY_TARGETS, releaseArchiveFileName } from '../lib/release-targets';
import { assertNoUnexpectedArguments, error, parseArgs, success } from '../lib/runner';
import { openZipArchive, type ZipArchiveDependencies } from '../lib/zip-archive';

interface ExtractTargetArchiveOptions {
  readonly archivePath: string;
  readonly archiveFormat: 'tar.gz' | 'zip';
  readonly destination: string;
  readonly expectedMembers: readonly string[];
  readonly rootDir: string;
}

export async function extractTargetArchive(
  options: ExtractTargetArchiveOptions,
  // Zip only; the tar.gz half reads the archive in-process and never probes for unzip.
  dependencies: ZipArchiveDependencies = {}
): Promise<void> {
  const archive =
    options.archiveFormat === 'zip'
      ? await openZipArchive(options.archivePath, dependencies)
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
