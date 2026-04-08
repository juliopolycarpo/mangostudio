import { describe, expect, it } from 'bun:test';
import { maskSecret } from '../../../src/utils/secrets';

describe('maskSecret', () => {
  it('returns undefined for null', () => {
    expect(maskSecret(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(maskSecret(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(maskSecret('')).toBeUndefined();
  });

  it('returns **** for a 1-character key', () => {
    expect(maskSecret('a')).toBe('****');
  });

  it('returns **** for an exactly 4-character key', () => {
    expect(maskSecret('abcd')).toBe('****');
  });

  it('masks a normal long key showing last 4 chars', () => {
    expect(maskSecret('sk-abc123xyz9876')).toBe('****...9876');
  });

  it('masks a 5-character key', () => {
    expect(maskSecret('abcde')).toBe('****...bcde');
  });
});
