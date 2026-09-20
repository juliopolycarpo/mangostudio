/**
 * Byte-level helpers behind `fs.read-file`, re-homed from the hub's read_file
 * tool test when the hub stopped importing them.
 */

import { describe, expect, it } from 'bun:test';
import {
  countTotalLines,
  findWindowByteRange,
  looksBinary,
} from '../../../../src/services/fs/read-file';

describe('countTotalLines / looksBinary / findWindowByteRange', () => {
  it('counts empty, newline-only, and trailing-newline files', () => {
    expect(countTotalLines(new Uint8Array())).toBe(0);
    expect(countTotalLines(new TextEncoder().encode('\n'))).toBe(1);
    expect(countTotalLines(new TextEncoder().encode('a\nb\n'))).toBe(2);
    expect(countTotalLines(new TextEncoder().encode('a\nb'))).toBe(2);
  });

  it('detects a NUL byte in the first 8 KiB as binary', () => {
    expect(looksBinary(new Uint8Array([0x00, 0x01]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode('plain text'))).toBe(false);
  });

  it('finds inclusive window byte ranges', () => {
    const bytes = new TextEncoder().encode('one\ntwo\nthree');
    expect(findWindowByteRange(bytes, 2, 2)).toEqual({ start: 4, end: 8 });
    expect(findWindowByteRange(bytes, 1, 3)).toEqual({ start: 0, end: 13 });
  });

  it('returns an empty range for an inverted window instead of the rest of the file', () => {
    const bytes = new TextEncoder().encode('one\ntwo\nthree');
    expect(findWindowByteRange(bytes, 2, 1)).toEqual({ start: 4, end: 4 });
    expect(findWindowByteRange(bytes, 1, 0)).toEqual({ start: 0, end: 0 });
  });
});
