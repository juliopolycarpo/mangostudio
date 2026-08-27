/**
 * The Windows command-line ceiling the argv-only design implies.
 *
 * Asserted on the boundary rather than on a round number: the budget carries
 * headroom for the executable path and the quoting `CreateProcess` adds, so a
 * test that only checked "40,000 is too long" would still pass if the budget
 * were raised past the OS limit it exists to stay under.
 */

import { describe, expect, it } from 'bun:test';
import {
  exceedsWindowsCommandLine,
  ghCommandLineLength,
} from '../../../../src/modules/github/domain/gh-command-line';

describe('ghCommandLineLength', () => {
  it('counts one separator per argument', () => {
    expect(ghCommandLineLength(['pr', 'create'])).toBe(10);
    expect(ghCommandLineLength([])).toBe(0);
  });

  it('counts UTF-16 units, which is what Windows counts', () => {
    // One astral emoji is two units there, not one character.
    expect(ghCommandLineLength(['🥭'])).toBe(3);
  });
});

describe('exceedsWindowsCommandLine', () => {
  it('accepts an ordinary pull request and refuses one past the budget', () => {
    expect(exceedsWindowsCommandLine(['pr', 'create', '--title=Fix', '--body=Because.'])).toBe(
      false
    );
    expect(exceedsWindowsCommandLine(['pr', 'create', `--body=${'x'.repeat(40_000)}`])).toBe(true);
  });

  it('stays under the 32,767-unit limit the OS enforces', () => {
    const atBudget = ['x'.repeat(29_999)];
    expect(ghCommandLineLength(atBudget)).toBeLessThan(32_767);
    expect(exceedsWindowsCommandLine(atBudget)).toBe(false);
    expect(exceedsWindowsCommandLine(['x'.repeat(30_000)])).toBe(true);
  });
});
