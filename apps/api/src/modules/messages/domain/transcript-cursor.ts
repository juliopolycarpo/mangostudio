/**
 * Position of one transcript row in the order the transcript is paged:
 * `(timestamp, rowid)` ascending. `timestamp` alone is not unique, so the
 * SQLite `rowid` breaks the tie in insertion order.
 */
export interface TranscriptCursor {
  timestamp: number;
  rowid: number;
}

// A stored timestamp is any finite JSON number (`POST /messages` accepts one), so
// the cursor must round-trip whatever `Number#toString` prints for it: a
// sign, a fraction or an exponent (`-5`, `1.5`, `1e+21`).
const TIMESTAMP_SOURCE = String.raw`-?\d+(?:\.\d+)?(?:e[+-]?\d+)?`;
const CURSOR_PATTERN = new RegExp(`^(${TIMESTAMP_SOURCE}):(\\d{1,16})$`);
const LEGACY_CURSOR_PATTERN = new RegExp(`^${TIMESTAMP_SOURCE}$`);

export const TRANSCRIPT_CURSOR_SHAPE = '<timestamp>:<rowid>';

/** Raised when a client sends a cursor this server did not issue. */
export class InvalidTranscriptCursorError extends Error {
  constructor(value: string) {
    super(
      `Invalid transcript cursor: ${JSON.stringify(value)} | expected shape: ${TRANSCRIPT_CURSOR_SHAPE}`
    );
    this.name = 'InvalidTranscriptCursorError';
  }
}

/**
 * Encodes a cursor as the opaque string a client sends back unchanged.
 *
 * @example
 * encodeTranscriptCursor({ timestamp: 1700000000000, rowid: 42 }); // '1700000000000:42'
 */
export function encodeTranscriptCursor(cursor: TranscriptCursor): string {
  return `${cursor.timestamp}:${cursor.rowid}`;
}

/**
 * Decodes a cursor produced by {@link encodeTranscriptCursor}.
 *
 * A bare numeric timestamp (the format servers issued before the cursor
 * carried a rowid) is still accepted, best effort, so a browser tab loaded
 * before an upgrade keeps paging instead of failing until reload. It is read as
 * "after every row of that timestamp" (rowid `Number.MAX_SAFE_INTEGER`), which
 * is exactly what the old `timestamp > cursor` filter did: rows tied with the
 * last row returned may be skipped, but none are repeated. Anything else that
 * does not match `<timestamp>:<rowid>` throws.
 *
 * @example
 * decodeTranscriptCursor('1700000000000:42'); // { timestamp: 1700000000000, rowid: 42 }
 * decodeTranscriptCursor('1700000000000'); // { timestamp: 1700000000000, rowid: 9007199254740991 }
 * decodeTranscriptCursor('abc'); // throws InvalidTranscriptCursorError
 */
export function decodeTranscriptCursor(value: string): TranscriptCursor {
  if (LEGACY_CURSOR_PATTERN.test(value)) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp)) throw new InvalidTranscriptCursorError(value);
    return { timestamp, rowid: Number.MAX_SAFE_INTEGER };
  }

  const match = CURSOR_PATTERN.exec(value);
  if (!match) throw new InvalidTranscriptCursorError(value);

  const timestamp = Number(match[1]);
  const rowid = Number(match[2]);
  if (!Number.isFinite(timestamp) || !Number.isSafeInteger(rowid)) {
    throw new InvalidTranscriptCursorError(value);
  }
  return { timestamp, rowid };
}
