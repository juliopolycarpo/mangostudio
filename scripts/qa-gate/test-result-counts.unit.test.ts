import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import {
  buildTestSuiteStats,
  parseTestPassCounts,
  parseTestResultCounts,
} from './test-result-counts';

const fixture = (name: string): Promise<string> =>
  Bun.file(join(import.meta.dir, 'testing/fixtures', `${name}.txt`)).text();

describe('parseTestPassCounts', () => {
  it('sums root and workspace test output from nested scripts', () => {
    const stats = parseTestPassCounts(`
  6 pass
@mangostudio/frontend test:unit:bun:  31 pass
@mangostudio/frontend test:unit:vitest: Tests 42 passed
@mangostudio/api test:unit:  120 pass
@mangostudio/shared test:unit:  18 pass
@mangostudio/runtime test:unit:  57 pass
`);

    expect(stats).toEqual({
      root: 6,
      frontend: 73,
      api: 120,
      shared: 18,
      runtime: 57,
    });
  });

  it('counts the coverage-pass task names emitted by the single CI test run', () => {
    const stats = parseTestPassCounts(`
  470 pass
@mangostudio/frontend test:coverage: Tests  254 passed (254)
@mangostudio/frontend test:coverage:  31 pass
@mangostudio/api test:coverage:  812 pass
@mangostudio/shared test:coverage:  96 pass
@mangostudio/runtime test:coverage:  57 pass
`);

    expect(stats).toEqual({
      root: 470,
      frontend: 285,
      api: 812,
      shared: 96,
      runtime: 57,
    });
  });
});

describe('parseTestResultCounts', () => {
  it('parses the nanostores unhandled-error log: green counts plus Errors 2', async () => {
    const parsed = parseTestResultCounts(await fixture('vitest-unhandled-nanostores'));

    expect(parsed.hasFailureSignal).toBe(true);
    expect(parsed.errors).toBe(2);
    expect(parsed.failed).toBe(0);
    expect(parsed.failedFiles).toBe(0);
    expect(parsed.headlines).toEqual([
      {
        message: 'ReferenceError: window is not defined',
        originatedIn: 'tests/unit/features/library/backup-list.test.tsx',
      },
    ]);
  });

  it('parses the toast auto-dismiss unhandled-error log: green counts plus Errors 1', async () => {
    const parsed = parseTestResultCounts(await fixture('vitest-unhandled-toast'));

    expect(parsed.hasFailureSignal).toBe(true);
    expect(parsed.errors).toBe(1);
    expect(parsed.failed).toBe(0);
    expect(parsed.headlines).toEqual([
      {
        message: 'ReferenceError: window is not defined',
        originatedIn: 'tests/unit/components/git-panel.test.tsx',
      },
    ]);
  });

  it('parses Vitest Test Files / Tests failed counts from the default reporter', async () => {
    const parsed = parseTestResultCounts(await fixture('vitest-failed-summary'));

    expect(parsed.hasFailureSignal).toBe(true);
    expect(parsed.failedFiles).toBe(1);
    expect(parsed.failed).toBe(2);
    expect(parsed.headlines?.[0]?.originatedIn).toBe('tests/unit/example.test.ts');
  });

  it('parses Bun fail counts from bun test output', async () => {
    const parsed = parseTestResultCounts(await fixture('bun-fail'));

    expect(parsed.hasFailureSignal).toBe(true);
    expect(parsed.failed).toBe(1);
    expect(parsed.passed.root).toBe(1);
  });

  it('parses a Bun unhandled-error-between-tests block', async () => {
    const parsed = parseTestResultCounts(await fixture('bun-unhandled-between-tests'));

    expect(parsed.hasFailureSignal).toBe(true);
    expect(parsed.errors).toBe(1);
    expect(parsed.failed).toBe(0);
    expect(parsed.passed.root).toBe(2);
    expect(parsed.headlines).toEqual([
      { message: 'error: boom between tests', originatedIn: null },
    ]);
  });

  it('parses Turbo-prefixed Vitest Errors and originated-in lines', () => {
    const parsed = parseTestResultCounts(`
@mangostudio/frontend test:coverage: Tests  1150 passed (1150)
@mangostudio/frontend test:coverage:     Errors  2 errors
@mangostudio/frontend test:coverage: ReferenceError: window is not defined
@mangostudio/frontend test:coverage: This error originated in "tests/unit/features/library/backup-list.test.tsx" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.
`);

    expect(parsed.passed.frontend).toBe(1150);
    expect(parsed.errors).toBe(2);
    expect(parsed.headlines).toEqual([
      {
        message: 'ReferenceError: window is not defined',
        originatedIn: 'tests/unit/features/library/backup-list.test.tsx',
      },
    ]);
  });
});

describe('buildTestSuiteStats', () => {
  it('records errors on a green-count Vitest run that still exited 1', async () => {
    const stats = buildTestSuiteStats(await fixture('vitest-unhandled-nanostores'), 1, 165);

    expect(stats.exitCode).toBe(1);
    expect(stats.errors).toBe(2);
    expect(stats.parseMiss).toBeUndefined();
    expect(stats.headlines?.[0]?.originatedIn).toContain('backup-list.test.tsx');
  });

  it('sets parseMiss on a non-zero exit with no failure signal, not zeros', () => {
    const stats = buildTestSuiteStats('turbo compiled\nsome unrelated output\n', 1, 12);

    expect(stats).toMatchObject({
      exitCode: 1,
      durationSeconds: 12,
      passed: 0,
      parseMiss: true,
    });
    expect(stats.failed).toBeUndefined();
    expect(stats.errors).toBeUndefined();
    expect(stats.headlines).toBeUndefined();
  });

  it('omits failure fields on a green run', () => {
    const stats = buildTestSuiteStats(
      `
  6 pass
@mangostudio/frontend test:unit:bun:  31 pass
@mangostudio/api test:unit:  120 pass
@mangostudio/shared test:unit:  18 pass
@mangostudio/runtime test:unit:  57 pass
`,
      0,
      240
    );

    expect(stats.exitCode).toBe(0);
    expect(stats.parseMiss).toBeUndefined();
    expect(stats.failed).toBeUndefined();
    expect(stats.errors).toBeUndefined();
    expect(stats.headlines).toBeUndefined();
    expect(stats.passed).toBe(6 + 31 + 120 + 18 + 57);
  });
});
