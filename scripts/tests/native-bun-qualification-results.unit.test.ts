import { describe, expect, test } from 'bun:test';

import { type NativeTestLane, parseNativeTestLog } from '../lib/native-bun-qualification-results';
import { parseJunitXml } from '../qa-gate/junit-results';

const inventory: NativeTestLane[] = [
  {
    id: 'root',
    task: '//#test:scripts',
    cwd: '',
    manifest: 'package.json',
    script: 'bun test scripts',
    files: ['scripts/root.test.ts'],
  },
  {
    id: 'api-unit',
    task: '@mangostudio/api:test:unit',
    cwd: 'apps/api',
    manifest: 'apps/api/package.json',
    script: 'bun test tests/unit',
    files: ['apps/api/tests/unit/real.test.ts'],
  },
  {
    id: 'protocol',
    task: '',
    cwd: '',
    manifest: 'package.json',
    script: 'bun test packages/protocol',
    files: ['packages/protocol/real.test.ts'],
  },
];
const root = parseJunitXml(
  '<testsuites tests="1"><testcase name="real root test" file="scripts/root.test.ts" /></testsuites>'
);

function completeLog(): string {
  return [
    '//:test:scripts: scripts/root.test.ts:',
    '//:test:scripts: (fail) some suite > quoted by a fixture [1.00ms]',
    '//:test:scripts: @mangostudio/api:test:unit: (fail) nested quoted fixture',
    '//:test:scripts: 1 error',
    '@mangostudio/api:test:unit: tests/unit/real.test.ts:',
    '@mangostudio/api:test:unit: (pass) real API case [1.00ms]',
    '@mangostudio/api:test:unit: 1 pass',
    '@mangostudio/api:test:unit: 0 fail',
    '@mangostudio/api:test:unit: Ran 1 test across 1 file. [1.00ms]',
    'packages/protocol/real.test.ts:',
    '(skip) optional protocol interop',
    'Ran 1 test across 1 file. [1.00ms]',
  ].join('\n');
}

describe('default suite raw evidence', () => {
  test('counts skipped cases once when Bun repeats them in its final recap', () => {
    const recapped = completeLog().replace(
      '(skip) optional protocol interop\nRan',
      '(skip) optional protocol interop\n1 test skipped:\n(skip) optional protocol interop\nRan'
    );
    const lanes = parseNativeTestLog(recapped, inventory, root);
    expect(lanes[2].cases).toHaveLength(1);
    expect(lanes[2].recaps).toHaveLength(1);
    expect(lanes[2].errors).toEqual([]);
  });
  test('uses root XML and exact outer prefixes instead of counting falsified fixtures', () => {
    const lanes = parseNativeTestLog(completeLog(), inventory, root);
    expect(lanes.map((lane) => lane.errors)).toEqual([[], [], []]);
    expect(lanes[0].cases).toEqual([
      {
        line: 0,
        file: 'scripts/root.test.ts',
        name: 'scripts/root.test.ts||real root test|',
        outcome: 'passed',
      },
    ]);
    expect(lanes[1].cases).toHaveLength(1);
    expect(lanes[1].cases[0].name).toBe('real API case');
    expect(lanes[2].cases[0].outcome).toBe('skipped');
  });

  test('refuses a zero-exit shape with missing lanes or no case records', () => {
    const absent = parseNativeTestLog('//:test:scripts: scripts/root.test.ts:', inventory, root);
    expect(absent[1].errors.join('\n')).toContain('Missing 1 required files');
    expect(absent[1].errors.join('\n')).toContain('No testcase outcomes');
    const empty = parseNativeTestLog(
      completeLog().replace('@mangostudio/api:test:unit: (pass) real API case [1.00ms]', ''),
      inventory,
      root
    );
    expect(empty[1].errors.join('\n')).toContain('differs from 0 cases');
  });

  test('preserves failures, unhandled errors, and truncated summaries', () => {
    const failed = parseNativeTestLog(
      completeLog()
        .replace('(pass) real API case', '(fail) real API case')
        .replace(
          '@mangostudio/api:test:unit: 0 fail',
          '@mangostudio/api:test:unit: # Unhandled error between tests'
        ),
      inventory,
      root
    );
    expect(failed[1].cases[0].outcome).toBe('failed');
    expect(failed[1].errors.join('\n')).toContain('Unhandled error between tests');
    expect(failed[1].errors.join('\n')).toContain('Failing testcase');
    const truncated = parseNativeTestLog(
      completeLog().replace('Ran 1 test across 1 file. [1.00ms]', ''),
      inventory,
      root
    );
    expect(truncated[1].errors.join('\n')).toContain('Expected one complete Bun summary');
    const missingXml = parseNativeTestLog(completeLog(), inventory, null);
    expect(missingXml[0].errors).toContain('Missing, empty, or truncated root JUnit');
  });

  test('normalizes ANSI and Windows relative file paths without losing outcome identity', () => {
    const ansiEscape = String.fromCharCode(27);
    const log = completeLog().replace(
      'tests/unit/real.test.ts:',
      `${ansiEscape}[32mtests\\unit\\real.test.ts:${ansiEscape}[0m\r`
    );
    const lanes = parseNativeTestLog(log, inventory, root);
    expect(lanes[1].files).toEqual(['apps/api/tests/unit/real.test.ts']);
    expect(lanes[1].errors).toEqual([]);
  });
});
