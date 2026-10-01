import type { MessagesOrder } from '@mangostudio/shared/chat';
import { parseCursorPosition } from './cursor-position';

/**
 * Position of one transcript row in the transcript's one total order:
 * `(timestamp, rowid)` ascending. `timestamp` alone is not unique, so the
 * SQLite `rowid` breaks the tie in insertion order. Paging newest-first walks
 * the same order backwards, so a position means the same row in either
 * direction.
 */
export interface TranscriptCursor {
  timestamp: number;
  rowid: number;
}

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
 * A cursor names a position, not a direction: one issued under `asc` reads the
 * same under `desc` and the other way round (the next page is the rows after
 * it, or before it).
 *
 * A bare numeric timestamp (the format servers issued before the cursor
 * carried a rowid) is still accepted, best effort, so a browser tab loaded
 * before an upgrade keeps paging instead of failing until reload. It stands for
 * the whole group of rows of that timestamp, and the next page starts outside
 * the group: after it for `asc` (rowid `Number.MAX_SAFE_INTEGER`, exactly what
 * the old `timestamp > cursor` filter did) and before it for `desc` (rowid `0`,
 * below every stored rowid). Rows tied with the last row returned may be
 * skipped, but none are repeated. Anything else that does not match
 * `<timestamp>:<rowid>` throws.
 *
 * @example
 * decodeTranscriptCursor('1700000000000:42'); // { timestamp: 1700000000000, rowid: 42 }
 * decodeTranscriptCursor('1700000000000'); // { timestamp: 1700000000000, rowid: 9007199254740991 }
 * decodeTranscriptCursor('1700000000000', 'desc'); // { timestamp: 1700000000000, rowid: 0 }
 * decodeTranscriptCursor('abc'); // throws InvalidTranscriptCursorError
 */
export function decodeTranscriptCursor(
  value: string,
  order: MessagesOrder = 'asc'
): TranscriptCursor {
  const position = parseCursorPosition(value);
  if (!position) throw new InvalidTranscriptCursorError(value);
  const outsideTheTie = order === 'asc' ? Number.MAX_SAFE_INTEGER : 0;
  return { timestamp: position.timestamp, rowid: position.rowid ?? outsideTheTie };
}
