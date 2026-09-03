/**
 * Clamps a fit-proposed terminal size to what the wire will accept.
 *
 * `FitAddon.proposeDimensions()` reflects the container and font metrics
 * only; it knows nothing about `TerminalSizeSchema`'s bounds. An ultrawide
 * pop-out or a small font routinely proposes past `TERMINAL_COLS_MAX`. Left
 * unclamped, the hub closes the socket with 1003 and the client treats that
 * as a transport failure and reconnects — proposing the same oversized fit
 * again, forever.
 *
 * The bounds are read from the contract rather than passed in: "the wire's
 * bounds" is the whole reason this function exists, and parameterizing them let
 * the test assert the arithmetic against four numbers it had retyped itself —
 * so a change to `TERMINAL_COLS_MAX` would leave it green.
 *
 * @example
 * const size = clampTerminalSize(proposed);
 * if (size) term.resize(size.cols, size.rows);
 */

import {
  TERMINAL_COLS_MAX,
  TERMINAL_COLS_MIN,
  TERMINAL_ROWS_MAX,
  TERMINAL_ROWS_MIN,
} from '@mangostudio/shared/terminal';

export function clampTerminalSize(proposed: {
  readonly cols: number;
  readonly rows: number;
}): { readonly cols: number; readonly rows: number } | null {
  // `NaN` survives every comparison below (`NaN < 2` is false) and `Math.min`
  // propagates it, so an unmeasurable container would otherwise reach the wire
  // as `{"cols":null}` — a schema violation the hub answers with a 1003 close,
  // which is the reconnect loop this whole function exists to prevent.
  if (!Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return null;
  if (proposed.cols < TERMINAL_COLS_MIN || proposed.rows < TERMINAL_ROWS_MIN) return null;
  return {
    cols: Math.min(proposed.cols, TERMINAL_COLS_MAX),
    rows: Math.min(proposed.rows, TERMINAL_ROWS_MAX),
  };
}
