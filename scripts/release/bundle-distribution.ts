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

async function createBundle(path: string, members: readonly string[]): Promise<void> {
  const result = await captureCommand(['tar', '-czf', path, ...members], { cwd: ROOT_DIR });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create ${path}: ${result.stderr || result.stdout}`);
  }
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

  const packagedPath = join(BUNDLE_DIR, 'packaged.tar.gz');
  await createBundle(packagedPath, [DISTRIBUTION_MANIFEST_FILE, 'release-assets', 'dist-npm']);
  const packagedArtifact = distributionArtifactName(
    'packaged',
    manifest.sourceSha,
    manifest.packageVersion,
    await digest(packagedPath)
  );

  const bundles = await mapWithConcurrency(
    manifest.targets,
    archiveConcurrency(),
    async (target) => {
      const bundlePath = join(BUNDLE_DIR, `${target.id}.tar.gz`);
      await createBundle(bundlePath, [
        DISTRIBUTION_MANIFEST_FILE,
        `.mango/out/${target.id}`,
        target.archive,
        'release-assets/SHA256SUMS',
      ]);
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
    appendFileSync(process.env.GITHUB_OUTPUT, `packaged_artifact=${packagedArtifact}\n`);
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `target_artifacts=${JSON.stringify(targetArtifacts)}\n`
    );
  }
  success(`Distribution bundles written to ${BUNDLE_DIR}`);
}

try {
  await main();
} catch (caught) {
  error(caught instanceof Error ? caught.message : String(caught));
  process.exit(1);
}
