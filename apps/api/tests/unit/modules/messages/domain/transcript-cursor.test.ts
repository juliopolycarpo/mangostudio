import { describe, expect, it } from 'bun:test';
import {
  decodeTranscriptCursor,
  encodeTranscriptCursor,
  InvalidTranscriptCursorError,
} from '../../../../../src/modules/messages/domain/transcript-cursor';

function decodeError(value: string): Error | null {
  try {
    decodeTranscriptCursor(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

describe('transcript cursor', () => {
  it('round-trips timestamp and rowid', () => {
    const cursor = { timestamp: 1_700_000_000_000, rowid: 42 };

    expect(decodeTranscriptCursor(encodeTranscriptCursor(cursor))).toEqual(cursor);
    expect(encodeTranscriptCursor(cursor)).toBe('1700000000000:42');
  });

  it('reads a bare numeric timestamp from the previous format as after every row of it', () => {
    expect(decodeTranscriptCursor('1700000000000')).toEqual({
      timestamp: 1_700_000_000_000,
      rowid: Number.MAX_SAFE_INTEGER,
    });
  });

  it.each([
    ['a fractional timestamp', 1.5],
    ['a negative timestamp', -5],
    ['a timestamp beyond the safe integer range', 1e21],
    ['a tiny fractional timestamp', 1.5e-7],
  ])('round-trips %s that POST /messages can store', (_label, timestamp) => {
    const cursor = { timestamp, rowid: 3 };

    expect(decodeTranscriptCursor(encodeTranscriptCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ['a bare timestamp too large to be finite', '1e999'],
    ['a timestamp too large to be finite', '1e999:1'],
    ['an empty rowid', '1700000000000:'],
    ['a negative rowid', '1700000000000:-1'],
    ['a fractional rowid', '1:1.5'],
    ['non-numeric text', 'abc:def'],
    ['an extra segment', '1:2:3'],
    ['an unsafe rowid', '1:9999999999999999'],
  ])('rejects %s', (_label, value) => {
    const error = decodeError(value);

    expect(error?.name ?? 'no error thrown').toBe(InvalidTranscriptCursorError.name);
    expect(error?.message).toContain(JSON.stringify(value));
    expect(error?.message).toContain('expected shape: <timestamp>:<rowid>');
  });
});
