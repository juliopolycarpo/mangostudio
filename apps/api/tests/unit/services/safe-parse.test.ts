import { describe, expect, it } from 'bun:test';
import { parseJsonValueOrRawString, safeJsonParse } from '../../../src/lib/safe-parse';

describe('safeJsonParse', () => {
  it('returns an object when the payload is a JSON object', () => {
    expect(safeJsonParse('{"ok":true}')).toEqual({ ok: true });
  });

  it('returns null for non-object JSON payloads', () => {
    expect(safeJsonParse('[1,2,3]')).toBeNull();
  });
});

describe('parseJsonValueOrRawString', () => {
  it('returns parsed JSON values', () => {
    expect(parseJsonValueOrRawString('{"ok":true}')).toEqual({ ok: true });
    expect(parseJsonValueOrRawString('[1,2,3]')).toEqual([1, 2, 3]);
    expect(parseJsonValueOrRawString('42')).toBe(42);
  });

  it('returns the original string when JSON.parse fails', () => {
    expect(parseJsonValueOrRawString('plain text')).toBe('plain text');
  });
});
