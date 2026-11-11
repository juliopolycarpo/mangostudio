#!/usr/bin/env bun

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { requiredEnv } from '../lib/args';
import { ROOT_DIR } from '../lib/config';
import { parseRuntimeProfile } from '../lib/distribution-manifest';
import { ALL_BINARY_TARGETS } from '../lib/release-targets';
import { resolveReleaseVersion } from '../lib/release-version';
import { readRuntimeArtifactReceipt } from '../lib/runtime-artifact';
import { hostPlatformId, prebuiltRuntimePath, verifyRuntimeBinary } from '../lib/runtime-build';

const platform = requiredEnv('PLATFORM');
const target = ALL_BINARY_TARGETS.find((candidate) => candidate.arch === platform);
if (!target) throw new Error(`expected release platform | received: ${platform}`);
const identity = {
  sourceSha: requiredEnv('SOURCE_SHA'),
  version: resolveReleaseVersion(),
  profile: parseRuntimeProfile(requiredEnv('RUNTIME_PROFILE')),
};
const runtimeDir = join(ROOT_DIR, '.mango/runtime-prebuilt');
const receipt = readRuntimeArtifactReceipt(runtimeDir, target, identity);
const path = prebuiltRuntimePath(runtimeDir, target);
if (process.platform !== 'win32') chmodSync(path, 0o755);
const verification = await verifyRuntimeBinary({
  path,
  target,
  version: identity.version,
  hostPlatform: hostPlatformId(),
  enforceGlibcFloor: true,
});
if (verification.problems.length > 0 || verification.reportedVersion !== identity.version) {
  throw new Error(
    `expected ${platform} runtime --version: ${identity.version} | received: ${verification.reportedVersion ?? 'not runnable'}${
      verification.problems.length ? `\n${verification.problems.join('\n')}` : ''
    }`
  );
}
const outDir = join(ROOT_DIR, '.mango/runtime-versions');
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, `${platform}.json`),
  `${JSON.stringify({ ...receipt, reportedVersion: verification.reportedVersion }, null, 2)}\n`
);
console.log(
  `Verified ${platform} runtime v${verification.reportedVersion} for ${identity.sourceSha}.`
);
