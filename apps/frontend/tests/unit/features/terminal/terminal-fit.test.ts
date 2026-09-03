import { describe, expect, it } from 'bun:test';
import {
  TERMINAL_COLS_MAX,
  TERMINAL_COLS_MIN,
  TERMINAL_ROWS_MAX,
  TERMINAL_ROWS_MIN,
} from '@mangostudio/shared/terminal';
import { clampTerminalSize } from '../../../../src/features/terminal/terminal-fit';

// Asserted against the contract's own constants, not a copy of their values:
// the point of the clamp is that it matches the wire, so a test carrying its
// own four numbers would stay green through the change that breaks it.
describe('clampTerminalSize', () => {
  it('clamps a fit proposal past the wire maximum instead of passing it through', () => {
    expect(
      clampTerminalSize({ cols: TERMINAL_COLS_MAX + 100, rows: TERMINAL_ROWS_MAX + 100 })
    ).toEqual({ cols: TERMINAL_COLS_MAX, rows: TERMINAL_ROWS_MAX });
  });

  it('passes a proposal already inside bounds through unchanged', () => {
    expect(clampTerminalSize({ cols: 120, rows: 40 })).toEqual({ cols: 120, rows: 40 });
  });

  it('drops a proposal below the wire minimum', () => {
    expect(clampTerminalSize({ cols: TERMINAL_COLS_MIN - 1, rows: 40 })).toBeNull();
    expect(clampTerminalSize({ cols: 120, rows: TERMINAL_ROWS_MIN - 1 })).toBeNull();
  });

  it('drops a non-finite proposal, which every comparison here would otherwise pass', () => {
    // `NaN < 2` is false and `Math.min(NaN, 500)` is NaN, so an unguarded clamp
    // sends `{"cols":null}` — a schema violation the hub closes the socket for.
    expect(clampTerminalSize({ cols: Number.NaN, rows: 40 })).toBeNull();
    expect(clampTerminalSize({ cols: 120, rows: Number.NaN })).toBeNull();
    expect(clampTerminalSize({ cols: Number.POSITIVE_INFINITY, rows: 40 })).toBeNull();
  });
});
