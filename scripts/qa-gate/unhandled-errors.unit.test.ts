import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import {
  mergeUnhandledErrors,
  parseUnhandledErrors,
  readUnhandledErrorsFile,
} from './unhandled-errors';

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

describe('readUnhandledErrorsFile', () => {
  const PATH = 'shards/test-shard-2/unhandled-errors.json';

  it('reads the extractor output back unchanged', () => {
    const value = { errors: 1, headlines: [{ message: 'error: boom', originatedIn: null }] };
    expect(readUnhandledErrorsFile(PATH, JSON.stringify(value))).toEqual({ kind: 'read', value });
  });

  // Each of these used to be read as `{errors: 0}`.
  it.each([
    ['no file', null, 'no such file'],
    ['an empty file', '', 'an empty file'],
    ['whitespace only', ' \n', 'an empty file'],
    ['truncated JSON', '{"errors": 2, "head', 'invalid JSON'],
    ['an array', '[]', '[]'],
    ['a string count', '{"errors":"2","headlines":[]}', '{"errors":"2","headlines":[]}'],
    ['a negative count', '{"errors":-1,"headlines":[]}', '{"errors":-1,"headlines":[]}'],
    ['a fractional count', '{"errors":1.5,"headlines":[]}', '{"errors":1.5,"headlines":[]}'],
    [
      'headlines that are not an array',
      '{"errors":0,"headlines":{}}',
      '{"errors":0,"headlines":{}}',
    ],
    [
      'a headline without a message',
      '{"errors":1,"headlines":[{}]}',
      '{"errors":1,"headlines":[{}]}',
    ],
    ['null', 'null', 'null'],
  ])('is unavailable, naming the path and shape, for %s', (_name, text, received) => {
    const read = readUnhandledErrorsFile(PATH, text);
    expect(read.kind).toBe('unavailable');
    if (read.kind !== 'unavailable') return;
    expect(read.reason).toContain(PATH);
    expect(read.reason).toContain('expected {"errors": <integer >= 0>');
    expect(read.reason).toContain(`| received: ${received}`);
  });
});

describe('unhandled-errors CLI', () => {
  const script = join(import.meta.dir, 'unhandled-errors.ts');
  const run = async (...args: string[]) => {
    const proc = Bun.spawn({ cmd: ['bun', script, ...args], stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  };

  // A shard that died before the runner wrote its log has an unknown count.
  it('exits 1 naming the path when the log does not exist, printing no JSON', async () => {
    const missing = join(import.meta.dir, 'testing/fixtures/no-such-run.log');
    const { stdout, stderr, exitCode } = await run(missing);
    expect(stdout).toBe('');
    expect(stderr).toContain(`expected a run log at ${missing} | received: no such file`);
    expect(exitCode).toBe(1);
  });

  it('prints the parsed counts for a log that exists', async () => {
    const log = join(import.meta.dir, 'testing/fixtures/bun-unhandled-between-tests.txt');
    const { stdout, exitCode } = await run(log);
    expect(JSON.parse(stdout)).toMatchObject({ errors: 1 });
    expect(exitCode).toBe(0);
  });
});
