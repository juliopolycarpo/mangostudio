import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { discardStandaloneReadme } from './build';
import { type HubBuildRecord, readHubBuildRecords, validateNativeHubSet } from './hub-build';
import { ALL_BINARY_TARGETS, runtimeBinaryName } from './release-targets';
import { renderStandaloneReadme } from './standalone-readme';

/**
 * Verify all native pairs before restoring transport-lost modes and marking completion.
 * @example assembleNativeHubs(root, { sourceSha, version })
 */
export function assembleNativeHubs(
  rootDir: string,
  expected: { readonly sourceSha: string; readonly version: string }
): HubBuildRecord[] {
  const outDir = join(rootDir, '.mango/out');
  discardStandaloneReadme(outDir);
  const records = readHubBuildRecords(rootDir);
  validateNativeHubSet(records, expected);
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
