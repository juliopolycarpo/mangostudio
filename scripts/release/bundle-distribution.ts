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
 * Stays on `tar`: bundles carry the raw hub and runtime binaries and the npm
 * platform packages, and `Bun.Archive` cannot store an executable bit. The npm
 * bundle is published from its extracted copy, so a `0644` binary there would
 * reach users. See the comment in `archive-assets.ts`.
 */
async function createBundle(path: string, members: readonly string[]): Promise<void> {
  const result = await captureCommand(['tar', '-czf', path, ...members], { cwd: ROOT_DIR });
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
      const bundlePath = join(BUNDLE_DIR, `${scope}.tar.gz`);
      await createBundle(bundlePath, members);
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
      const bundlePath = join(BUNDLE_DIR, `${target.id}.tar.gz`);
      await createBundle(bundlePath, targetBundleMembers(target));
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
