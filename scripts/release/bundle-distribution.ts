#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import {
  DISTRIBUTION_MANIFEST_FILE,
  distributionArtifactName,
  readDistributionManifest,
} from '../lib/distribution-manifest';
import { captureCommand } from '../lib/exec';
import { assertSafeToDelete } from '../lib/fs-assert';
import { error, header, success } from '../lib/runner';

const BUNDLE_DIR = join(ROOT_DIR, '.distribution-bundles');

async function createBundle(path: string, members: readonly string[]): Promise<void> {
  const result = await captureCommand(['tar', '-czf', path, ...members], { cwd: ROOT_DIR });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create ${path}: ${result.stderr || result.stdout}`);
  }
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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
    digest(packagedPath)
  );

  const targetArtifacts: Record<string, string> = {};
  for (const target of manifest.targets) {
    const bundlePath = join(BUNDLE_DIR, `${target.id}.tar.gz`);
    await createBundle(bundlePath, [
      DISTRIBUTION_MANIFEST_FILE,
      `.mango/out/${target.id}`,
      target.archive,
      'release-assets/SHA256SUMS',
    ]);
    targetArtifacts[target.id] = distributionArtifactName(
      target.id,
      manifest.sourceSha,
      manifest.packageVersion,
      digest(bundlePath)
    );
  }

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
