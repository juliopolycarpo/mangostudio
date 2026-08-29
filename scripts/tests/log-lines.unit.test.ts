import { describe, expect, it } from 'bun:test';

import { normalizeLogLine } from '../lib/log-lines';

const ESC = String.fromCharCode(27);

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
