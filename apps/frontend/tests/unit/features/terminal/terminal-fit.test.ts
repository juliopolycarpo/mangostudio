import { describe, expect, it } from 'bun:test';
import { clampTerminalSize } from '../../../../src/features/terminal/terminal-fit';

const BOUNDS = { colsMin: 2, colsMax: 500, rowsMin: 1, rowsMax: 300 };

describe('clampTerminalSize', () => {
  it('clamps a fit proposal past the wire maximum instead of passing it through', () => {
    expect(clampTerminalSize({ cols: 600, rows: 400 }, BOUNDS)).toEqual({ cols: 500, rows: 300 });
  });

  it('passes a proposal already inside bounds through unchanged', () => {
    expect(clampTerminalSize({ cols: 120, rows: 40 }, BOUNDS)).toEqual({ cols: 120, rows: 40 });
  });

  it('drops a proposal below the wire minimum', () => {
    expect(clampTerminalSize({ cols: 1, rows: 40 }, BOUNDS)).toBeNull();
    expect(clampTerminalSize({ cols: 120, rows: 0 }, BOUNDS)).toBeNull();
  });

  it('drops a non-finite proposal, which every comparison here would otherwise pass', () => {
    // `NaN < 2` is false and `Math.min(NaN, 500)` is NaN, so an unguarded clamp
    // sends `{"cols":null}` — a schema violation the hub closes the socket for.
    expect(clampTerminalSize({ cols: Number.NaN, rows: 40 }, BOUNDS)).toBeNull();
    expect(clampTerminalSize({ cols: 120, rows: Number.NaN }, BOUNDS)).toBeNull();
    expect(clampTerminalSize({ cols: Number.POSITIVE_INFINITY, rows: 40 }, BOUNDS)).toBeNull();
  });
});
