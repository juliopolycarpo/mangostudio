import { describe, expect, it } from 'bun:test';
import { parseStyleParams } from '../../../src/db/serializers';

describe('parseStyleParams', () => {
  it('returns undefined for null', () => {
    expect(parseStyleParams(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(parseStyleParams(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseStyleParams('')).toBeUndefined();
  });

  it('returns undefined for invalid JSON', () => {
    expect(parseStyleParams('not-json')).toBeUndefined();
  });

  it('returns undefined for non-array JSON payloads', () => {
    expect(parseStyleParams('"a string"')).toBeUndefined();
    expect(parseStyleParams('42')).toBeUndefined();
    expect(parseStyleParams('{"key":"value"}')).toBeUndefined();
  });

  it('returns the string array for a valid array', () => {
    expect(parseStyleParams('["a","b","c"]')).toEqual(['a', 'b', 'c']);
  });

  it('filters out non-string elements from mixed arrays', () => {
    expect(parseStyleParams('["a",1,null,true,"b"]')).toEqual(['a', 'b']);
  });

  it('returns an empty array for an empty JSON array', () => {
    expect(parseStyleParams('[]')).toEqual([]);
  });
});
