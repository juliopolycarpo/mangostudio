#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { CanaryGitHub } from '../lib/canary-github';
import type { CanaryReleaseExpectation } from '../lib/canary-release';
import {
  type CanaryReleaseAssetStore,
  publishVerifiedCanaryRelease,
} from '../lib/canary-release-publisher';
import { requiredEnv } from '../lib/runner';

async function main(): Promise<void> {
  const raw = readFileSync(requiredEnv('EXPECTED_RELEASE'));
  const expectedDigest = process.env.EXPECTED_RELEASE_SHA256;
  if (expectedDigest !== undefined) {
    const actual = createHash('sha256').update(raw).digest('hex');
    if (!/^[a-f0-9]{64}$/.test(expectedDigest) || actual !== expectedDigest) {
      throw new Error(
        `Expected release plan SHA256: expected ${expectedDigest}; received ${actual}`
      );
    }
  }
  // The workflow authenticates this plan before invoking the publisher. The
  // optional hash pins a downloaded same-run plan without redefining provenance.
  const expected: unknown = JSON.parse(raw.toString('utf8'));
  const repository = requiredEnv('REPO');
  if (
    !expected ||
    typeof expected !== 'object' ||
    !('repository' in expected) ||
    expected.repository !== repository
  ) {
    throw new Error(`Expected release plan: expected object for repository ${repository}`);
  }
  const directory = resolve(process.env.ASSET_DIR ?? 'github-canary-assets');
  const assets: CanaryReleaseAssetStore = {
    read: async (name) => await Bun.file(join(directory, name)).bytes(),
    path: (name) => join(directory, name),
  };
  const result = await publishVerifiedCanaryRelease(
    expected as CanaryReleaseExpectation,
    assets,
    new CanaryGitHub(repository)
  );
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  try {
    await main();
  } catch (caught) {
    console.error(caught instanceof Error ? caught.message : String(caught));
    process.exitCode = 1;
  }
}
