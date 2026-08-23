import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { mergeUnhandledErrors, parseUnhandledErrors } from './unhandled-errors';

// Captured runner output: a real `bun test` unhandled-error block, whose JUnit
// report reads failures="0" while the run exits 1.
const fixture = (name: string): Promise<string> =>
  Bun.file(join(import.meta.dir, 'testing/fixtures', `${name}.txt`)).text();

describe('parseUnhandledErrors', () => {
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

  it('finds nothing in a green log', () => {
    const parsed = parseUnhandledErrors(
      ' 1352 pass\n 0 fail\n 3062 expect() calls\nRan 1352 tests across 157 files. [82.52s]\n'
    );
    expect(parsed).toEqual({ errors: 0, headlines: [] });
  });

  it('does not read a Bun pass or fail summary line as an error count', () => {
    expect(parseUnhandledErrors(' 812 pass\n 0 fail\n 2 expect() calls\n').errors).toBe(0);
  });

  it('ignores GitHub Actions workflow-command lines', () => {
    expect(parseUnhandledErrors('##[error]9 errors\n').errors).toBe(0);
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
