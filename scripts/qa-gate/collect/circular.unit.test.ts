import { describe, expect, it } from 'bun:test';

import { circularRoots, countCircularDeps, parseCycleReport } from './circular';
import type { ComponentSpec } from './registry';
import type { RunResult } from './support';

/** Named fake for a scanner result and the commands sent to it. */
function fakeScanner(result: RunResult) {
  const calls: string[][] = [];
  const run = (command: readonly string[]): Promise<RunResult> => {
    calls.push([...command]);
    return Promise.resolve(result);
  };
  return { run, calls };
}

const report = (cycles: unknown[], exitCode = cycles.length ? 1 : 0): RunResult => ({
  stdout: JSON.stringify({ cycles }),
  stderr: '',
  exitCode,
});

describe('countCircularDeps', () => {
  it('scans all roots together and counts closed paths once', async () => {
    const scanner = fakeScanner(report([['apps/api/a.ts', 'apps/shared/b.ts', 'apps/api/a.ts']]));
    expect(await countCircularDeps(['apps/api', 'apps/shared'], scanner.run)).toBe(1);
    expect(scanner.calls).toEqual([
      ['bun', 'scripts/check-import-cycles.ts', '--json', 'apps/api', 'apps/shared'],
    ]);
  });

  it('does not scan the current directory when no roots were given', async () => {
    const scanner = fakeScanner(report([]));
    expect(await countCircularDeps([], scanner.run)).toBe(0);
    expect(scanner.calls).toEqual([]);
  });

  it('rejects process errors rather than reporting a clean metric', () => {
    expect(() =>
      parseCycleReport({ stdout: '', stderr: 'scanner unavailable', exitCode: 2 })
    ).toThrow('scanner unavailable');
    expect(() => parseCycleReport(report([], 2))).toThrow('expected exit 0 | received 2');
    expect(() => parseCycleReport(report([['a.ts', 'a.ts']], 0))).toThrow(
      'expected exit 1 | received 0'
    );
  });

  it.each([
    [{}, 'cycles array'],
    [{ cycles: 'none' }, 'cycles array'],
    [{ cycles: [['a.ts']] }, 'closed path'],
    [{ cycles: [['a.ts', 'b.ts']] }, 'closed path'],
    [{ cycles: [['', '']] }, 'closed path'],
  ])('rejects malformed report %#', (value, expected) => {
    expect(() =>
      parseCycleReport({ stdout: JSON.stringify(value), stderr: '', exitCode: 0 })
    ).toThrow(expected);
  });
});

describe('circularRoots', () => {
  const spec = (kind: ComponentSpec['kind'], name: string, root: string): ComponentSpec => ({
    id: `${kind}:${name}`,
    kind,
    name,
    root,
    hasTsconfig: false,
  });
  it('selects every JS workspace and scripts, never a Rust crate', () => {
    expect(
      circularRoots([
        spec('workspace', 'api', 'apps/api'),
        spec('crate', 'mango-protocol', 'crates/mango-protocol'),
        spec('scripts', 'scripts', 'scripts'),
        spec('workspace', 'protocol', 'packages/protocol'),
      ])
    ).toEqual(['apps/api', 'scripts', 'packages/protocol']);
  });
});
