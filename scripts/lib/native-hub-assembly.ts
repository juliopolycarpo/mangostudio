import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { discardStandaloneReadme } from './build';
import {
  type HubBuildRecord,
  parseHubBuildRecord,
  readHubBuildRecords,
  readHubCompileRecord,
  validateNativeHubSet,
} from './hub-build';
import { ALL_BINARY_TARGETS, runtimeBinaryName } from './release-targets';
import { readRuntimeArtifactReceipt, type RuntimeArtifactIdentity } from './runtime-artifact';
import { prebuiltRuntimePath } from './runtime-build';
import { renderStandaloneReadme } from './standalone-readme';

interface NativeRuntimeInputs {
  readonly runtimeDir: string;
  readonly versionReceiptsDir: string;
  readonly profile: RuntimeArtifactIdentity['profile'];
}

function pairNativeArtifacts(
  rootDir: string,
  identity: RuntimeArtifactIdentity,
  inputs: NativeRuntimeInputs
): HubBuildRecord[] {
  const compiles = ALL_BINARY_TARGETS.map((target) => readHubCompileRecord(rootDir, target));
  validateNativeHubSet(compiles, identity);
  const records = ALL_BINARY_TARGETS.map((target, index) => {
    const runtime = readRuntimeArtifactReceipt(inputs.runtimeDir, target, identity);
    if (runtime.reportedVersion === null) {
      const path = join(inputs.versionReceiptsDir, `${target.arch}.json`);
      if (!existsSync(path)) {
        throw new Error(
          `expected ${target.arch} runtime version receipt at ${path} | received: missing`
        );
      }
      const verified = readRuntimeArtifactReceipt(inputs.runtimeDir, target, identity, path);
      if (verified.reportedVersion !== identity.version) {
        throw new Error(
          `expected ${target.arch} runtime reportedVersion: ${identity.version} | received: ${verified.reportedVersion}`
        );
      }
    }
    return parseHubBuildRecord({
      ...compiles[index],
      runtimeSha256: runtime.sha256,
      runtimeSize: runtime.size,
    });
  });

  // Leave every target untouched until the complete pair set has validated.
  const recordsDir = join(rootDir, '.mango/hub-builds');
  mkdirSync(recordsDir, { recursive: true });
  for (const [index, target] of ALL_BINARY_TARGETS.entries()) {
    const runtime = runtimeBinaryName(target.name);
    copyFileSync(
      prebuiltRuntimePath(inputs.runtimeDir, target),
      join(rootDir, '.mango/out', target.arch, runtime)
    );
    writeFileSync(
      join(recordsDir, `${target.arch}.json`),
      `${JSON.stringify(records[index], null, 2)}\n`
    );
  }
  return records;
}

/**
 * Verify all native pairs before restoring executable modes and marking completion.
 * @example assembleNativeHubs(root, { sourceSha, version }, runtimeInputs)
 */
export function assembleNativeHubs(
  rootDir: string,
  expected: { readonly sourceSha: string; readonly version: string },
  inputs?: NativeRuntimeInputs
): HubBuildRecord[] {
  const outDir = join(rootDir, '.mango/out');
  discardStandaloneReadme(outDir);
  const records = inputs
    ? pairNativeArtifacts(rootDir, { ...expected, profile: inputs.profile }, inputs)
    : readHubBuildRecords(rootDir);
  if (!inputs) validateNativeHubSet(records, expected);
  for (const target of ALL_BINARY_TARGETS) {
    if (target.arch.startsWith('windows-')) continue;
    chmodSync(join(outDir, target.arch, target.name), 0o755);
    chmodSync(join(outDir, target.arch, runtimeBinaryName(target.name)), 0o755);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'README.md'),
    renderStandaloneReadme(
      { version: expected.version, buildType: 'production' },
      ALL_BINARY_TARGETS,
      records[0].builtAt
    )
  );
  return records;
}
