import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import {
  createSourceScanCommand,
  resolveSourceScan,
  SOURCE_SCANS,
  type SourceScanName,
} from '../lib/source-scans';
import { readText } from './support/read-text';

// `bun run check` runs each source scan as a process of its own: on the
// runner's thread a four-second synchronous parse held back every spawn.

const SCAN_NAMES = Object.keys(SOURCE_SCANS) as SourceScanName[];

function runScanScript(...args: string[]): { exitCode: number; stderr: string } {
  const [, script] = createSourceScanCommand('node-env-branches');
  const run = Bun.spawnSync([process.execPath, script, ...args], {
    cwd: ROOT_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: run.exitCode, stderr: run.stderr.toString() };
}

describe('createSourceScanCommand', () => {
  test.each(SCAN_NAMES)('%s names the entry script and the scan', (name) => {
    const command = createSourceScanCommand(name);
    expect(command).toEqual(['bun', './scripts/check-source-scan.ts', name]);
    expect(existsSync(join(ROOT_DIR, command[1]))).toBe(true);
  });
});

describe('resolveSourceScan', () => {
  test.each(SCAN_NAMES)('%s resolves to its scan', (name) => {
    expect(resolveSourceScan([name])).toBe(SOURCE_SCANS[name]);
  });

  test.each([
    ['no argument', [], 'no argument'],
    ['an unknown name', ['shared-imports'], 'shared-imports'],
    ['an inherited property name', ['toString'], 'toString'],
    ['a second argument', ['node-env-branches', '--fix'], 'node-env-branches --fix'],
  ] as const)('rejects %s, naming what it received', (_name, args, received) => {
    expect(() => resolveSourceScan(args)).toThrow(
      `(check-source-scan): expected one scan name: ${SCAN_NAMES.join(' | ')} | received: ${received}`
    );
  });
});

describe('check-source-scan.ts', () => {
  test('exits 0 for a scan the checkout passes', () => {
    const { exitCode, stderr } = runScanScript('node-env-branches');
    expect(exitCode, stderr).toBe(0);
  });

  test('exits 1 and prints the expected names for an unknown scan', () => {
    const { exitCode, stderr } = runScanScript('shared-imports');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('| received: shared-imports');
  });
});

describe('bun run check', () => {
  test.each(SCAN_NAMES)('runs %s as its own process', (name) => {
    expect(readText('scripts/check.ts')).toContain(`createSourceScanCommand('${name}')`);
  });

  test('keeps no source scan on the runner thread', () => {
    const checkScript = readText('scripts/check.ts');
    for (const assertion of [
      'assertNoSharedRootImports',
      'assertFrontendApiImportBoundary',
      'assertNoProductionNodeEnvBranches',
    ]) {
      expect(
        checkScript,
        `(check): expected no in-process call | received: ${assertion}`
      ).not.toContain(assertion);
    }
  });
});
