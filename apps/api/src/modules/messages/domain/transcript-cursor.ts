/**
 * Position of one transcript row in the order the transcript is paged:
 * `(timestamp, rowid)` ascending. `timestamp` alone is not unique, so the
 * SQLite `rowid` breaks the tie in insertion order.
 */
export interface TranscriptCursor {
  timestamp: number;
  rowid: number;
}

const CURSOR_PATTERN = /^(\d{1,16}):(\d{1,16})$/;

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
 * Decodes a cursor produced by {@link encodeTranscriptCursor}. A bare numeric
 * timestamp (the previous cursor format) is refused: it cannot say which of
 * several rows sharing that timestamp were already returned.
 *
 * @example
 * decodeTranscriptCursor('1700000000000:42'); // { timestamp: 1700000000000, rowid: 42 }
 * decodeTranscriptCursor('1700000000000'); // throws InvalidTranscriptCursorError
 */
export function decodeTranscriptCursor(value: string): TranscriptCursor {
  const match = CURSOR_PATTERN.exec(value);
  if (!match) throw new InvalidTranscriptCursorError(value);

  const timestamp = Number(match[1]);
  const rowid = Number(match[2]);
  if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(rowid)) {
    throw new InvalidTranscriptCursorError(value);
  }
  return { timestamp, rowid };
}
