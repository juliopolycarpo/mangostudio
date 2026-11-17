import { describe, expect, test } from 'bun:test';

import { type ByteRangeVerdict, resolveByteRange } from '../../../src/server/byte-range';

const SIZE = 100;
const whole: ByteRangeVerdict = { kind: 'whole' };
const unsatisfiable: ByteRangeVerdict = { kind: 'unsatisfiable' };
const partial = (start: number, end: number): ByteRangeVerdict => ({
  kind: 'partial',
  start,
  end,
});

describe('resolveByteRange', () => {
  test('treats an absent header as the whole body', () => {
    expect(resolveByteRange(null, SIZE)).toEqual(whole);
  });

  test.each([
    ['bytes=0-9', partial(0, 9)],
    ['bytes=5-', partial(5, 99)],
    ['bytes=99-', partial(99, 99)],
    ['bytes=-7', partial(93, 99)],
    ['bytes=-100', partial(0, 99)],
    ['bytes=-1000', partial(0, 99)],
    ['bytes=0-0', partial(0, 0)],
    ['bytes=0-99', partial(0, 99)],
    ['bytes=0-99999999999', partial(0, 99)],
    ['bytes= 0 - 9 ', partial(0, 9)],
    ['BYTES=0-9', partial(0, 9)],
  ])('%s resolves to a satisfiable range', (header, expected) => {
    expect(resolveByteRange(header, SIZE)).toEqual(expected);
  });

  test.each(['bytes=100-', 'bytes=1000-', 'bytes=100-200', 'bytes=-0'])(
    '%s is unsatisfiable for a 100-byte body',
    (header) => {
      expect(resolveByteRange(header, SIZE)).toEqual(unsatisfiable);
    }
  );

  test.each([
    'bytes=0-1,5-6',
    'bytes=5-2',
    'bytes=abc',
    'bytes=-',
    'bytes=0-9,',
    'bytes=0-9;x',
    'items=0-1',
    '0-9',
    '',
  ])('%p is not a single byte range, so it means the whole body', (header) => {
    expect(resolveByteRange(header, SIZE)).toEqual(whole);
  });

  test('has nothing to range over an empty body', () => {
    expect(resolveByteRange('bytes=0-', 0)).toEqual(unsatisfiable);
    expect(resolveByteRange('bytes=-5', 0)).toEqual(unsatisfiable);
  });
});
