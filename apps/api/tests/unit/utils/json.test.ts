import { describe, expect, it } from 'bun:test';
import { parseStringArray } from '../../../src/utils/json';

describe('parseStringArray', () => {
  it('parses a valid JSON string array', () => {
    expect(parseStringArray('["a","b","c"]')).toEqual(['a', 'b', 'c']);
  });

  it('returns empty array for a JSON array with non-string items', () => {
    expect(parseStringArray('[1,2,3]')).toEqual([]);
  });

  it('returns empty array for a JSON object', () => {
    expect(parseStringArray('{"key":"value"}')).toEqual([]);
  });

  it('returns empty array for a bare string', () => {
    expect(parseStringArray('"just a string"')).toEqual([]);
  });

  it('returns empty array for an empty string', () => {
    expect(parseStringArray('')).toEqual([]);
  });

  it('returns empty array for null', () => {
    expect(parseStringArray('null')).toEqual([]);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseStringArray('not json at all')).toEqual([]);
  });

  it('returns empty array for a number', () => {
    expect(parseStringArray('42')).toEqual([]);
  });

  it('returns empty array for an empty JSON array', () => {
    expect(parseStringArray('[]')).toEqual([]);
  });
});
