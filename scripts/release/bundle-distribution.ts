#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import {
  DISTRIBUTION_MANIFEST_FILE,
  distributionArtifactName,
  readDistributionManifest,
} from '../lib/distribution-manifest';
import { archiveConcurrency, captureCommand, mapWithConcurrency } from '../lib/exec';
import { assertSafeToDelete } from '../lib/fs-assert';
import { error, header, success } from '../lib/runner';

const BUNDLE_DIR = join(ROOT_DIR, '.distribution-bundles');

const BUNDLE_SCOPES = {
  checksums: [DISTRIBUTION_MANIFEST_FILE, 'release-assets/SHA256SUMS'],
  assets: [DISTRIBUTION_MANIFEST_FILE, 'release-assets'],
  npm: [DISTRIBUTION_MANIFEST_FILE, 'dist-npm'],
} as const;

/**
 * How a bundle's payload responds to gzip. Not uniform, because the payloads are
 * not alike — see `createBundle` for the measurements behind each choice.
 */
export type BundleCompression = 'store' | 'gzip';

/** Raw hub and runtime binaries, npm platform packages, or plain text. */
export const SCOPED_BUNDLE_COMPRESSION: BundleCompression = 'gzip';

/** One already-compressed platform archive plus two small text files. */
export const TARGET_BUNDLE_COMPRESSION: BundleCompression = 'store';

/**
 * Name a bundle after the bytes it actually holds. A stored tar under a
 * `.tar.gz` name would defeat `tar -xzf` for anyone reaching for one by hand.
 * // Usage: bundleFileName('linux-x64', TARGET_BUNDLE_COMPRESSION) === 'linux-x64.tar'
 */
export function bundleFileName(name: string, compression: BundleCompression): string {
  return compression === 'store' ? `${name}.tar` : `${name}.tar.gz`;
}

/**
 * Compression is chosen per bundle because the payloads differ, measured on a
 * real linux-x64 asset set:
 *
 * - A **target** bundle is the manifest, `SHA256SUMS`, and one platform archive
 *   that is already `.tar.gz` (or `.zip`). Gzip has nothing left to find in the
 *   member holding 99% of the bytes: `-czf` spends 3.06 s to save 3.37 MB of
 *   82.78 MB, where storing costs 0.15 s. Stored.
 * - A **scoped** bundle carries uncompressed hub and runtime binaries
 *   (`assets`), the npm platform packages (`npm`), or plain text (`checksums`),
 *   so gzip does real work — but not at level 6. Level 1 halves the CPU for
 *   3.8% more bytes (12.87 s → 6.62 s, 159.17 MB → 165.24 MB per target's
 *   worth), and artifact upload measured at ~117 MB/s makes those bytes far
 *   cheaper than the seconds.
 *
 * Every upload runs at `compression-level: 0`, so this is the only compression
 * in the path either way; storing moves no work into the artifact zip.
 *
 * Stays on `tar` rather than `Bun.Archive` in both cases: bundles carry the raw
 * binaries and the npm bundle is published from its extracted copy, so the
 * `0644` entries `Bun.Archive` writes would reach users. See the comment in
 * `archive-assets.ts`.
 */
async function createBundle(
  path: string,
  members: readonly string[],
  compression: BundleCompression
): Promise<void> {
  // GNU tar; this script has exactly one call site, on ubuntu-latest.
  const compressionArgs = compression === 'store' ? [] : ['--use-compress-program', 'gzip -1'];
  const result = await captureCommand(['tar', ...compressionArgs, '-cf', path, ...members], {
    cwd: ROOT_DIR,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create ${path}: ${result.stderr || result.stdout}`);
  }
}

export function targetBundleMembers(target: { readonly archive: string }): readonly string[] {
  return [DISTRIBUTION_MANIFEST_FILE, target.archive, 'release-assets/SHA256SUMS'];
}

// Streamed rather than readFileSync: bundles are hashed concurrently, so buffering
// each whole tarball would multiply peak memory by the concurrency limit.
async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function main(): Promise<void> {
  header('Bundle distribution artifacts');
  const manifest = readDistributionManifest(join(ROOT_DIR, DISTRIBUTION_MANIFEST_FILE));

  assertSafeToDelete(BUNDLE_DIR, { rootDir: ROOT_DIR, label: 'distribution bundle directory' });
  rmSync(BUNDLE_DIR, { force: true, recursive: true });
  mkdirSync(BUNDLE_DIR, { recursive: true });

  const scopedEntries = await mapWithConcurrency(
    Object.entries(BUNDLE_SCOPES),
    archiveConcurrency(),
    async ([scope, members]) => {
      const bundlePath = join(BUNDLE_DIR, bundleFileName(scope, SCOPED_BUNDLE_COMPRESSION));
      await createBundle(bundlePath, members, SCOPED_BUNDLE_COMPRESSION);
      return [
        scope,
        distributionArtifactName(
          scope,
          manifest.sourceSha,
          manifest.packageVersion,
          await digest(bundlePath)
        ),
      ] as const;
    }
  );
  const scopedArtifacts = Object.fromEntries(scopedEntries) as Record<
    keyof typeof BUNDLE_SCOPES,
    string
  >;

  const bundles = await mapWithConcurrency(
    manifest.targets,
    archiveConcurrency(),
    async (target) => {
      const bundlePath = join(BUNDLE_DIR, bundleFileName(target.id, TARGET_BUNDLE_COMPRESSION));
      await createBundle(bundlePath, targetBundleMembers(target), TARGET_BUNDLE_COMPRESSION);
      return [
        target.id,
        distributionArtifactName(
          target.id,
          manifest.sourceSha,
          manifest.packageVersion,
          await digest(bundlePath)
        ),
      ] as const;
    }
  );
  const targetArtifacts = Object.fromEntries(bundles);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `checksums_artifact=${scopedArtifacts.checksums}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `assets_artifact=${scopedArtifacts.assets}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `npm_artifact=${scopedArtifacts.npm}\n`);
    // Transitional alias of assets_artifact; remove after one transition cycle.
    appendFileSync(process.env.GITHUB_OUTPUT, `packaged_artifact=${scopedArtifacts.assets}\n`);
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `target_artifacts=${JSON.stringify(targetArtifacts)}\n`
    );
  }
  success(`Distribution bundles written to ${BUNDLE_DIR}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  }
}
