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

  it.each([
    ['a bare numeric timestamp from the previous format', '1700000000000'],
    ['an empty rowid', '1700000000000:'],
    ['a negative rowid', '1700000000000:-1'],
    ['a fractional timestamp', '1.5:3'],
    ['non-numeric text', 'abc:def'],
    ['an extra segment', '1:2:3'],
    ['an unsafe integer', '9999999999999999:1'],
  ])('rejects %s', (_label, value) => {
    const error = decodeError(value);

    expect(error?.name ?? 'no error thrown').toBe(InvalidTranscriptCursorError.name);
    expect(error?.message).toContain(JSON.stringify(value));
    expect(error?.message).toContain('expected shape: <timestamp>:<rowid>');
  });
});
