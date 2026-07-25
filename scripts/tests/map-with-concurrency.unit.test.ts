import { describe, expect, test } from 'bun:test';

import { mapWithConcurrency } from '../lib/exec';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('mapWithConcurrency', () => {
  test('returns an empty array for empty input', async () => {
    await expect(mapWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
  });

  test('rejects a NaN limit instead of silently running nothing', async () => {
    let calls = 0;
    await expect(
      mapWithConcurrency([1, 2, 3], Number('not-a-number'), (value) => {
        calls += 1;
        return Promise.resolve(value);
      })
    ).rejects.toThrow(/limit must be a number/);
    expect(calls).toBe(0);
  });

  test('runs every item when the limit is fractional or infinite', async () => {
    await expect(mapWithConcurrency([1, 2, 3], 2.7, async (v) => v * 2)).resolves.toEqual([
      2, 4, 6,
    ]);
    await expect(
      mapWithConcurrency([1, 2, 3], Number.POSITIVE_INFINITY, async (v) => v * 2)
    ).resolves.toEqual([2, 4, 6]);
  });

  test('preserves input order in results', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrency(items, 3, async (value) => {
      await delay((6 - value) * 5);
      return value * 10;
    });

    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  test('respects the concurrency bound', async () => {
    let inFlight = 0;
    let peakInFlight = 0;

    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await delay(20);
      inFlight -= 1;
      return 0;
    });

    expect(peakInFlight).toBe(2);
  });

  test('propagates the first rejection after in-flight work settles', async () => {
    const started: number[] = [];

    await expect(
      mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
        started.push(value);
        await delay(10);
        if (value === 2) {
          throw new Error('task failed');
        }
        return value;
      })
    ).rejects.toThrow('task failed');

    expect(started).toContain(1);
    expect(started).toContain(2);
    expect(started.length).toBeGreaterThanOrEqual(2);
  });
});
