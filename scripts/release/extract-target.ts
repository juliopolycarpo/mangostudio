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

type MemberKind = 'directory' | 'file' | 'other' | 'symlink';

/**
 * Compare the whole extracted tree, not only its top level, against the layout the
 * manifest promises. `expectedMembers` are regular files, as POSIX paths relative to
 * `destination`; their parent directories are implied. A truncated or padded subtree
 * therefore fails even when its top-level directory exists.
 *
 * The distribution manifest only records regular files (`collectFiles` refuses
 * anything else), so a symlink or special file in a target archive is never legitimate
 * and is refused outright instead of being followed or compared.
 *
 * Every offending path is named in one error, sorted so the message is stable.
 */
export function assertMaterializedMembers(
  destination: string,
  expectedMembers: readonly string[]
): void {
  const expected = expectedLayout(expectedMembers);
  const actual = new Map<string, MemberKind>();
  walkMaterializedTree(destination, '', actual);

  const problems: Array<{ path: string; message: string }> = [];
  const report = (path: string, detail: string): void => {
    problems.push({ path, message: `${path}: ${detail}` });
  };
  for (const [path, kind] of actual) {
    if (kind === 'symlink' || kind === 'other') {
      report(path, `${kind === 'symlink' ? 'symlink' : 'special file'} refused`);
    } else if (!expected.has(path)) {
      report(path, `unexpected ${kind}`);
    }
  }
  for (const [path, kind] of expected) {
    const found = actual.get(path);
    if (found === undefined) {
      report(path, `missing ${kind}`);
    } else if (found !== kind && found !== 'symlink' && found !== 'other') {
      report(path, `expected ${kind}, got ${found}`);
    }
  }

  if (problems.length > 0) {
    problems.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    throw new Error(
      `Target archive layout mismatch:\n${problems.map((problem) => problem.message).join('\n')}`
    );
  }
}

function expectedLayout(expectedMembers: readonly string[]): Map<string, MemberKind> {
  const expected = new Map<string, MemberKind>();
  for (const member of expectedMembers) {
    const segments = member.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      expected.set(segments.slice(0, depth).join('/'), 'directory');
    }
    expected.set(member, 'file');
  }
  return expected;
}

function walkMaterializedTree(
  root: string,
  relativeDirectory: string,
  found: Map<string, MemberKind>
): void {
  for (const entry of readdirSync(join(root, relativeDirectory), { withFileTypes: true })) {
    const path = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
    // Dirent reports the entry itself, so a symlink is never followed into its target.
    if (entry.isSymbolicLink()) found.set(path, 'symlink');
    else if (entry.isDirectory()) {
      found.set(path, 'directory');
      walkMaterializedTree(root, path, found);
    } else found.set(path, entry.isFile() ? 'file' : 'other');
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
