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
 * @example
 * const size = clampTerminalSize(proposed, { colsMin, colsMax, rowsMin, rowsMax });
 * if (size) term.resize(size.cols, size.rows);
 */
export function clampTerminalSize(
  proposed: { readonly cols: number; readonly rows: number },
  bounds: {
    readonly colsMin: number;
    readonly colsMax: number;
    readonly rowsMin: number;
    readonly rowsMax: number;
  }
): { readonly cols: number; readonly rows: number } | null {
  // `NaN` survives every comparison below (`NaN < 2` is false) and `Math.min`
  // propagates it, so an unmeasurable container would otherwise reach the wire
  // as `{"cols":null}` — a schema violation the hub answers with a 1003 close,
  // which is the reconnect loop this whole function exists to prevent.
  if (!Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return null;
  if (proposed.cols < bounds.colsMin || proposed.rows < bounds.rowsMin) return null;
  return {
    cols: Math.min(proposed.cols, bounds.colsMax),
    rows: Math.min(proposed.rows, bounds.rowsMax),
  };
}
