import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { mergeUnhandledErrors, parseUnhandledErrors } from './unhandled-errors';

// Captured runner output: the two Vitest instances in docs/reference/testing.md
// ("Unhandled Errors With Green Test Counts") and the Bun block, whose JUnit
// report reads failures="0" while the run exits 1.
const fixture = (name: string): Promise<string> =>
  Bun.file(join(import.meta.dir, 'testing/fixtures', `${name}.txt`)).text();

describe('parseUnhandledErrors', () => {
  it('parses the nanostores log: green counts plus Errors 2', async () => {
    const parsed = parseUnhandledErrors(await fixture('vitest-unhandled-nanostores'));
    expect(parsed.errors).toBe(2);
    // Both errors report the same message and the same originating file, so
    // they collapse to one headline rather than repeating.
    expect(parsed.headlines).toEqual([
      {
        message: 'ReferenceError: window is not defined',
        originatedIn: 'tests/unit/features/library/backup-list.test.tsx',
      },
    ]);
  });

  it('parses the toast auto-dismiss log: green counts plus Errors 1', async () => {
    const parsed = parseUnhandledErrors(await fixture('vitest-unhandled-toast'));
    expect(parsed.errors).toBe(1);
    expect(parsed.headlines).toEqual([
      {
        message: 'ReferenceError: window is not defined',
        originatedIn: 'tests/unit/components/git-panel.test.tsx',
      },
    ]);
  });

  // Bun's JUnit report for this run is green — no failing <testcase>, and
  // failures="0" — so without the log the QA fragment would report parseMiss
  // and lose the message naming the leak.
  it('parses a Bun unhandled-error-between-tests block', async () => {
    const parsed = parseUnhandledErrors(await fixture('bun-unhandled-between-tests'));
    expect(parsed.errors).toBe(1);
    expect(parsed.headlines).toEqual([
      { message: 'error: boom between tests', originatedIn: null },
    ]);
  });

  it('keeps a Bun headline when another lane emits a pass line in between', () => {
    const parsed = parseUnhandledErrors(
      [
        '@mangostudio/api:test:coverage: # Unhandled error between tests',
        '@mangostudio/shared:test:coverage: (pass) unrelated',
        '@mangostudio/shared:test:coverage:  1 pass',
        '@mangostudio/api:test:coverage: error: boom between tests',
        '@mangostudio/api:test:coverage:  2 pass',
        '@mangostudio/api:test:coverage:  1 error',
      ].join('\n')
    );
    expect(parsed.errors).toBe(1);
    expect(parsed.headlines).toEqual([
      { message: 'error: boom between tests', originatedIn: null },
    ]);
  });

  it('reads Turbo-prefixed lines, which is the shape a shard job produces', () => {
    const parsed = parseUnhandledErrors(
      [
        '@mangostudio/frontend:test:coverage: TypeError: fetch failed',
        '@mangostudio/frontend:test:coverage: This error originated in "tests/unit/a.test.tsx" test file.',
        '@mangostudio/frontend:test:coverage:      Errors  3 errors',
      ].join('\n')
    );
    expect(parsed.errors).toBe(3);
    expect(parsed.headlines).toEqual([
      { message: 'TypeError: fetch failed', originatedIn: 'tests/unit/a.test.tsx' },
    ]);
  });

  it('finds nothing in a green log', () => {
    const parsed = parseUnhandledErrors(
      ' Test Files  144 passed (144)\n      Tests  1150 passed (1150)\n   Duration  164.54s\n'
    );
    expect(parsed).toEqual({ errors: 0, headlines: [] });
  });

  it('does not read a Bun pass or fail summary line as an error count', () => {
    expect(parseUnhandledErrors(' 812 pass\n 0 fail\n 2 expect() calls\n').errors).toBe(0);
  });

  it('ignores GitHub Actions workflow-command lines', () => {
    expect(parseUnhandledErrors('##[error]Errors  9 errors\n').errors).toBe(0);
  });

  it('keeps two errors that share a message but not a file', () => {
    const parsed = parseUnhandledErrors(
      [
        'ReferenceError: window is not defined',
        'This error originated in "tests/unit/a.test.tsx" test file.',
        'ReferenceError: window is not defined',
        'This error originated in "tests/unit/b.test.tsx" test file.',
      ].join('\n')
    );
    expect(parsed.headlines).toHaveLength(2);
  });
});

describe('mergeUnhandledErrors', () => {
  it('sums counts and unions headlines across shards', () => {
    const merged = mergeUnhandledErrors([
      { errors: 2, headlines: [{ message: 'Error: a', originatedIn: 'a.tsx' }] },
      { errors: 1, headlines: [{ message: 'Error: b', originatedIn: 'b.tsx' }] },
    ]);
    expect(merged.errors).toBe(3);
    expect(merged.headlines).toHaveLength(2);
  });

  it('caps the merged headline list', () => {
    const parts = Array.from({ length: 4 }, (_, index) => ({
      errors: 1,
      headlines: [
        { message: `Error: ${index}a`, originatedIn: `${index}a.tsx` },
        { message: `Error: ${index}b`, originatedIn: `${index}b.tsx` },
      ],
    }));
    expect(mergeUnhandledErrors(parts).headlines).toHaveLength(5);
  });
});
