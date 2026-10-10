import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  diffInventories,
  isIdentical,
  logicalId,
  packageName,
  parseTerseList,
  parseTestExecutables,
  summarizeResults,
} from '../bench/rust-test-inventory';

describe('logicalId', () => {
  test('keeps the binary name of an ordinary target', () => {
    expect(logicalId('mango-protocol', 'test', 'session', 'a_case')).toBe(
      'mango-protocol/test/session::a_case'
    );
  });

  test('folds a module of the consolidated binary back under its former binary', () => {
    expect(logicalId('mango-protocol', 'test', 'it', 'session::nested::a_case')).toBe(
      logicalId('mango-protocol', 'test', 'session', 'nested::a_case')
    );
  });

  test('does not fold a unit-test binary that happens to be named it', () => {
    expect(logicalId('p', 'lib', 'it', 'a::b')).toBe('p/lib/it::a::b');
  });

  test('rejects a top-level case in the consolidated binary', () => {
    expect(() => logicalId('p', 'test', 'it', 'orphan')).toThrow(
      'has a top-level test "orphan"; expected "<module>::<test>"'
    );
  });
});

describe('packageName', () => {
  test('reads every package_id form cargo has used', () => {
    expect(packageName('mango-protocol 0.2.0 (path+file:///w/crates/mango-protocol)')).toBe(
      'mango-protocol'
    );
    expect(packageName('path+file:///w/crates/mango-protocol#mango-protocol@0.2.0')).toBe(
      'mango-protocol'
    );
    expect(packageName('path+file:///w/crates/mango-protocol#0.2.0')).toBe('mango-protocol');
  });
});

describe('parseTerseList', () => {
  test('keeps tests and drops benchmarks', () => {
    expect(parseTerseList('a::b: test\nc: benchmark\n\nd: test\n')).toEqual(['a::b', 'd']);
  });

  test('rejects a line that is not a libtest entry', () => {
    expect(() => parseTerseList('3 tests, 0 benchmarks')).toThrow(
      'unexpected libtest --list line "3 tests, 0 benchmarks"; expected "<name>: test"'
    );
  });
});

describe('diffInventories', () => {
  const before = { 'p/test/a::x': { ignored: false }, 'p/test/a::y': { ignored: true } };

  test('is identical for the same identities and flags', () => {
    expect(isIdentical(diffInventories(before, { ...before }))).toBe(true);
  });

  test('reports a missing, an added and a re-flagged case', () => {
    const after = { 'p/test/a::x': { ignored: true }, 'p/test/a::z': { ignored: false } };
    const diff = diffInventories(before, after);
    expect(diff).toEqual({
      missing: ['p/test/a::y'],
      added: ['p/test/a::z'],
      ignoredChanged: ['p/test/a::x'],
      countChanged: [],
    });
    expect(isIdentical(diff)).toBe(false);
  });
});

describe('shared support cases', () => {
  test('fold to one identity whichever binary carries them', () => {
    expect(logicalId('p', 'test', 'cli', 'support::scratch::tests::a')).toBe(
      logicalId('p', 'test', 'it', 'support::scratch::tests::a')
    );
  });

  test('a lower binary count is reported but is not a difference', () => {
    const before = { 'p/test/support::a': { ignored: false, count: 15 } };
    const after = { 'p/test/support::a': { ignored: false, count: 1 } };
    const diff = diffInventories(before, after);
    expect(diff.countChanged).toEqual(['p/test/support::a (15 -> 1 binaries)']);
    expect(isIdentical(diff)).toBe(true);
  });
});

describe('summarizeResults', () => {
  test('sums every test result line', () => {
    const log = [
      'test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.1s',
      'test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.1s',
    ].join('\n');
    expect(summarizeResults(log)).toEqual({
      binaries: 2,
      passed: 7,
      failed: 0,
      ignored: 1,
      filteredOut: 2,
    });
  });
});

describe('parseTestExecutables', () => {
  const artifact = (over: object) =>
    JSON.stringify({
      reason: 'compiler-artifact',
      package_id: 'path+file:///w/crates/mango-protocol#mango-protocol@0.2.0',
      executable: '/t/deps/session-1',
      profile: { test: true },
      target: { name: 'session', kind: ['test'] },
      ...over,
    });

  test('keeps test harness artifacts with package, kind and binary', () => {
    expect(parseTestExecutables(artifact({}))).toEqual([
      { pkg: 'mango-protocol', kind: 'test', binary: 'session', path: '/t/deps/session-1' },
    ]);
  });

  test('skips non-test artifacts and non-JSON lines', () => {
    const lines = [
      'Compiling x',
      artifact({ profile: { test: false } }),
      artifact({ executable: null }),
    ];
    expect(parseTestExecutables(lines.join('\n'))).toEqual([]);
  });
});

// Cargo Shim's nextest parity step is `capture`, `capture-nextest`, then
// `compare`; its exit code is the gate. These tests run the real CLI so a
// `compare` that stops failing on a mismatch fails here, not in a silent CI step.
describe('compare command exit code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rust-test-inventory-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const libtest = { 'p/test/a::x': { ignored: false }, 'p/test/a::y': { ignored: true } };

  function compare(name: string, nextest: object) {
    const before = join(dir, `${name}-libtest.json`);
    const after = join(dir, `${name}-nextest.json`);
    writeFileSync(before, JSON.stringify(libtest));
    writeFileSync(after, JSON.stringify(nextest));
    const result = Bun.spawnSync(
      ['bun', 'scripts/bench/rust-test-inventory.ts', 'compare', before, after],
      { cwd: join(import.meta.dir, '..', '..') }
    );
    return { code: result.exitCode, out: result.stdout.toString() };
  }

  test('exits 0 for the same identities and flags', () => {
    const { code, out } = compare('same', libtest);
    expect(code, `expected exit code: 0 | received: ${code}\n${out}`).toBe(0);
  });

  test.each([
    ['a case nextest does not list', { 'p/test/a::x': { ignored: false } }, 'missing: p/test/a::y'],
    [
      'a case only nextest lists',
      { ...libtest, 'p/test/a::z': { ignored: false } },
      'added: p/test/a::z',
    ],
    [
      'a case nextest flags differently',
      { 'p/test/a::x': { ignored: true }, 'p/test/a::y': { ignored: true } },
      'ignoredChanged: p/test/a::x',
    ],
  ])('exits 1 and names the differing test for %s', (name, nextest, line) => {
    const { code, out } = compare(name.replaceAll(' ', '-'), nextest);
    expect(code, `expected exit code: 1 | received: ${code}\n${out}`).toBe(1);
    expect(out, `expected compare output to contain "${line}" | received: ${out}`).toContain(line);
  });
});
