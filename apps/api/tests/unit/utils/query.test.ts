import { describe, expect, it } from 'bun:test';

import { parsePageLimit } from '../../../src/utils/query';

const BOUNDS = { fallback: 50, max: 100 } as const;

describe('parsePageLimit', () => {
  it.each([
    ['1', 1],
    ['7', 7],
    ['100', 100],
    ['+25', 25],
    ['0042', 42],
  ])('keeps %s inside 1..max as %d', (raw, expected) => {
    expect(parsePageLimit(raw, BOUNDS)).toBe(expected);
  });

  it.each(['101', '100000', '99999999999999999999'])('clamps %s to the maximum', (raw) => {
    expect(parsePageLimit(raw, BOUNDS)).toBe(100);
  });

  it.each([undefined, '', ' ', 'abc', '1.5', '12abc', '0x10', '1e3', '0', '-0', '-1', '-100000'])(
    'falls back to the default for %p',
    (raw) => {
      expect(parsePageLimit(raw, BOUNDS)).toBe(50);
    }
  );
});
