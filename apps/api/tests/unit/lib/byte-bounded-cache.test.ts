import { describe, expect, test } from 'bun:test';

import { ByteBoundedCache } from '../../../src/lib/byte-bounded-cache';

function bytes(length: number): Uint8Array {
  return new Uint8Array(length);
}

describe('ByteBoundedCache', () => {
  test('computes a missing value once and returns the stored one afterwards', () => {
    const cache = new ByteBoundedCache<string>(100);
    let computed = 0;
    const compute = (): Uint8Array => {
      computed += 1;
      return bytes(40);
    };

    const first = cache.getOrCompute('a', compute);
    const second = cache.getOrCompute('a', compute);

    expect(computed).toBe(1);
    expect(second).toBe(first);
    expect(cache.totalBytes).toBe(40);
  });

  test('evicts the least recently used values until the total fits', () => {
    const cache = new ByteBoundedCache<string>(100);
    cache.getOrCompute('a', () => bytes(40));
    cache.getOrCompute('b', () => bytes(40));
    // Reading `a` makes `b` the oldest.
    cache.getOrCompute('a', () => bytes(0));

    cache.getOrCompute('c', () => bytes(40));

    expect(cache.totalBytes).toBe(80);
    let recomputedB = false;
    cache.getOrCompute('b', () => {
      recomputedB = true;
      return bytes(40);
    });
    expect(recomputedB).toBe(true);
  });

  test('never holds more than its budget, whatever the request order', () => {
    const cache = new ByteBoundedCache<number>(1000);
    for (let round = 0; round < 500; round += 1) {
      cache.getOrCompute((round * 7) % 13, () => bytes(50 + ((round * 31) % 400)));
      expect(cache.totalBytes).toBeLessThanOrEqual(1000);
    }
  });

  test('returns a value larger than the whole budget without storing it or evicting others', () => {
    const cache = new ByteBoundedCache<string>(100);
    cache.getOrCompute('small', () => bytes(30));

    const big = cache.getOrCompute('big', () => bytes(101));

    expect(big.byteLength).toBe(101);
    expect(cache.size).toBe(1);
    expect(cache.totalBytes).toBe(30);
  });

  test('refuses a budget that is not a non-negative integer', () => {
    expect(() => new ByteBoundedCache<string>(-1)).toThrow(
      'ByteBoundedCache: expected maxBytes as a non-negative integer | received: -1'
    );
    expect(() => new ByteBoundedCache<string>(1.5)).toThrow('received: 1.5');
  });
});
