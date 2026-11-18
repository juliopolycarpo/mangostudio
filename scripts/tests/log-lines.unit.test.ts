import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import {
  failSummaryCount,
  isInlineFailure,
  isUnhandledErrorHeading,
  normalizeLogLine,
  unhandledErrorCount,
} from '../lib/log-lines';

const ESC = String.fromCharCode(27);

// Real `bun test` output captured by the qa-gate suite (bun 1.3.14): one run
// with a failing test, one with an error raised between tests.
const FIXTURES = join(import.meta.dir, '../qa-gate/testing/fixtures');

const bodiesOf = async (fixture: string): Promise<string[]> =>
  (await Bun.file(join(FIXTURES, fixture)).text())
    .split('\n')
    .map((rawLine) => normalizeLogLine(rawLine).body);

describe('normalizeLogLine', () => {
  // The shape a direct `bun test` writes: no prefix, and Bun's summary lines
  // carry a leading space that every scanner would otherwise have to anchor
  // around.
  it('trims an unprefixed Bun line and reports no task key', () => {
    expect(normalizeLogLine(' 2 fail')).toEqual({ taskKey: '', body: '2 fail' });
  });

  // The shape `bun run test` writes: turbo `--ui=stream` prefixes every line,
  // so a scanner anchored on `^` sees the prefix, not Bun's output. This is
  // the whole reason the module exists.
  it('strips a turbo task prefix and hands back the task key', () => {
    expect(normalizeLogLine('@mangostudio/api:test:  2 fail')).toEqual({
      taskKey: '@mangostudio/api:test',
      body: '2 fail',
    });
  });

  // The root package is `//`, not `@scope/pkg`, and its task name itself
  // contains a colon — verified against `turbo run test:scripts --ui=stream`
  // on turbo 2.10.8, which prefixes with `//:test:scripts: `. (`//#test:scripts`
  // is the task *id*; it is not what reaches the log.)
  it('recognises the root-package task prefix', () => {
    expect(normalizeLogLine('//:test:scripts: (fail) a [0.37ms]')).toEqual({
      taskKey: '//:test:scripts',
      body: '(fail) a [0.37ms]',
    });
  });

  it('removes ANSI colour codes', () => {
    expect(normalizeLogLine(`${ESC}[31m(fail)${ESC}[0m a`).body).toBe('(fail) a');
  });

  // A log captured on Windows, or through a pipe that translated newlines,
  // ends every line with CR — which would defeat an `$`-anchored scan.
  it('drops a trailing carriage return', () => {
    expect(normalizeLogLine(' 1 fail\r').body).toBe('1 fail');
  });

  // A line that merely contains a colon is not a turbo prefix; treating it as
  // one would eat the start of Bun's own output.
  it('leaves a line that only looks prefixed alone', () => {
    expect(normalizeLogLine('error: something: went wrong')).toEqual({
      taskKey: '',
      body: 'error: something: went wrong',
    });
  });

  it('returns an empty body for a blank line', () => {
    expect(normalizeLogLine('   ')).toEqual({ taskKey: '', body: '' });
  });
});

describe('isUnhandledErrorHeading', () => {
  it("matches Bun's heading and nothing that merely contains it", () => {
    expect(isUnhandledErrorHeading('# Unhandled error between tests')).toBe(true);
    expect(isUnhandledErrorHeading('# Unhandled error between tests (2)')).toBe(false);
    expect(isUnhandledErrorHeading('Unhandled error between tests')).toBe(false);
  });
});

describe('unhandledErrorCount', () => {
  it.each([
    ['1 error', 1],
    ['2 errors', 2],
    ['0 error', 0],
  ])('reads the summary line %p as %p', (body, count) => {
    expect(unhandledErrorCount(body)).toBe(count);
  });

  // `1 error: <message>` is an ordinary line that starts with a number. The
  // watchdog's old `\b`-tailed copy matched it and turned a findings-free
  // night red.
  it("does not read an `N error: <message>` log line as Bun's summary", () => {
    expect(unhandledErrorCount("1 error: Cannot find module 'left-pad'")).toBeNull();
  });

  it('ignores lines that are not an error count', () => {
    expect(unhandledErrorCount('error: boom')).toBeNull();
    expect(unhandledErrorCount('2 fail')).toBeNull();
    expect(unhandledErrorCount('')).toBeNull();
  });
});

describe('failSummaryCount', () => {
  // A clean run prints ` 0 fail`; the shape must report the zero, not a miss,
  // so the caller can decide that it is no finding.
  it('reports the zero of a clean run as zero', () => {
    expect(failSummaryCount('0 fail')).toBe(0);
  });

  it('reads a non-zero summary, with or without the turbo prefix', () => {
    expect(failSummaryCount('2 fail')).toBe(2);
    expect(failSummaryCount(normalizeLogLine('@mangostudio/api:test:  3 fail').body)).toBe(3);
  });

  it('ignores a number-led line that is not the summary', () => {
    expect(failSummaryCount('1 failed to load fixture')).toBeNull();
    expect(failSummaryCount('1 pass')).toBeNull();
  });
});

describe('isInlineFailure', () => {
  it('matches a failing test and not a passing one', () => {
    expect(isInlineFailure('(fail) suite > name [0.37ms]')).toBe(true);
    expect(isInlineFailure('(pass) suite > name [0.37ms]')).toBe(false);
  });

  it('matches only at the start of the body', () => {
    expect(isInlineFailure('logged (fail) in the middle')).toBe(false);
  });
});

describe('the shapes against real Bun output', () => {
  it('finds the inline failure and the fail summary of a failing run', async () => {
    const bodies = await bodiesOf('bun-fail.txt');

    expect(bodies.filter(isInlineFailure)).toEqual(['(fail) fails [0.36ms]']);
    expect(bodies.map(failSummaryCount).filter((count) => count !== null)).toEqual([1]);
    expect(bodies.some(isUnhandledErrorHeading)).toBe(false);
    expect(bodies.map(unhandledErrorCount).filter((count) => count !== null)).toEqual([]);
  });

  it('finds the heading and error count of an error between tests, with a clean fail summary', async () => {
    const bodies = await bodiesOf('bun-unhandled-between-tests.txt');

    expect(bodies.filter(isUnhandledErrorHeading)).toHaveLength(1);
    expect(bodies.map(unhandledErrorCount).filter((count) => count !== null)).toEqual([1]);
    // JUnit reads this run as failures="0", and so does its fail summary.
    expect(bodies.map(failSummaryCount).filter((count) => count !== null)).toEqual([0]);
    expect(bodies.some(isInlineFailure)).toBe(false);
  });
});
