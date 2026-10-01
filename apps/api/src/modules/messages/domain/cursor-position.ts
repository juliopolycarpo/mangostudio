/**
 * Shared reader for the `<timestamp>:<rowid>` position that transcript and
 * gallery cursors both carry. Each cursor type owns its error message and what
 * a legacy position means in its own paging direction; this only parses.
 */
export interface CursorPosition {
  timestamp: number;
  /** `null` for a legacy cursor that carried only a timestamp. */
  rowid: number | null;
}

// A stored timestamp is any finite JSON number (`POST /messages` accepts one), so
// the cursor must round-trip whatever `Number#toString` prints for it: a
// sign, a fraction or an exponent (`-5`, `1.5`, `1e+21`).
const TIMESTAMP_SOURCE = String.raw`-?\d+(?:\.\d+)?(?:e[+-]?\d+)?`;
const POSITION_PATTERN = new RegExp(`^(${TIMESTAMP_SOURCE}):(\\d{1,16})$`);
const LEGACY_POSITION_PATTERN = new RegExp(`^${TIMESTAMP_SOURCE}$`);

/**
 * Parses `<timestamp>:<rowid>`, or a bare `<timestamp>` (the format issued
 * before cursors carried a rowid) as `{ timestamp, rowid: null }`. The timestamp
 * is any finite number `Number#toString` prints (signed, fractional or
 * exponent form); the rowid must be a safe integer. Returns `null` for
 * anything else, including a non-finite timestamp.
 *
 * @example
 * parseCursorPosition('1700000000000:42'); // { timestamp: 1700000000000, rowid: 42 }
 * parseCursorPosition('1700000000000'); // { timestamp: 1700000000000, rowid: null }
 * parseCursorPosition('abc'); // null
 */
export function parseCursorPosition(value: string): CursorPosition | null {
  if (LEGACY_POSITION_PATTERN.test(value)) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) ? { timestamp, rowid: null } : null;
  }

  const match = POSITION_PATTERN.exec(value);
  if (!match) return null;

  const timestamp = Number(match[1]);
  const rowid = Number(match[2]);
  return Number.isFinite(timestamp) && Number.isSafeInteger(rowid) ? { timestamp, rowid } : null;
}
