import { describe, expect, it } from 'bun:test';

import { mapWithConcurrency } from '../../src/utils/concurrency';

/** Yields to the event loop `turns` times so a fake task takes a controllable number of ticks. */
async function ticks(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

/** A fake task runner that records how many calls overlap and the order they began in. */
function instrumentedTask(ticksFor: (item: number) => number = () => 3) {
  const state = { inFlight: 0, peak: 0, started: [] as number[] };
  const task = async (item: number): Promise<number> => {
    state.started.push(item);
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    await ticks(ticksFor(item));
    state.inFlight -= 1;
    return item * 10;
  };
  return { state, task };
}

describe('mapWithConcurrency', () => {
  it('returns results in input order even when later items finish first', async () => {
    // Earlier items take longer, so completion order is the reverse of input order.
    const { task } = instrumentedTask((item) => 10 - item);

    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 5, task);

    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it('never has more calls in flight than the limit, and reaches it', async () => {
    const { state, task } = instrumentedTask();

    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, index) => index),
      4,
      task
    );

    expect(state.peak).toBe(4);
    expect(state.started).toHaveLength(20);
  });

  it('starts items in input order', async () => {
    const { state, task } = instrumentedTask();
    const items = Array.from({ length: 9 }, (_, index) => index);

    await mapWithConcurrency(items, 3, task);

    expect(state.started).toEqual(items);
  });

  it('runs one at a time when the limit is 1', async () => {
    const { state, task } = instrumentedTask();

    await mapWithConcurrency([1, 2, 3, 4], 1, task);

    expect(state.peak).toBe(1);
  });

  it('starts everything at once when the limit exceeds the item count', async () => {
    const { state, task } = instrumentedTask();

    const results = await mapWithConcurrency([1, 2, 3], 50, task);

    expect(state.peak).toBe(3);
    expect(results).toEqual([10, 20, 30]);
  });

  it('resolves to an empty array without calling the mapper for empty input', async () => {
    const { state, task } = instrumentedTask();

    const results = await mapWithConcurrency([], 4, task);

    expect(results).toEqual([]);
    expect(state.started).toEqual([]);
  });

  it.each([0, -3, Number.NaN])(
    'treats a limit of %p as 1 instead of skipping every item',
    async (limit) => {
      const { state, task } = instrumentedTask();

      const results = await mapWithConcurrency([1, 2, 3], limit, task);

      expect(results).toEqual([10, 20, 30]);
      expect(state.peak).toBe(1);
    }
  );

  it('floors a fractional limit', async () => {
    const { state, task } = instrumentedTask();

    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2.9, task);

    expect(state.peak).toBe(2);
  });

  it('maps an item that is undefined instead of skipping it', async () => {
    const seen: Array<string | undefined> = [];

    const results = await mapWithConcurrency<string | undefined, number>(
      ['a', undefined, 'b'],
      2,
      (item) => {
        seen.push(item);
        return Promise.resolve(seen.length);
      }
    );

    expect(seen).toEqual(['a', undefined, 'b']);
    expect(results).toEqual([1, 2, 3]);
  });

  it('rejects with the first failure', async () => {
    const failure = new Error('probe 2 failed');
    const task = (item: number): Promise<number> =>
      item === 2 ? Promise.reject(failure) : Promise.resolve(item);

    await expect(mapWithConcurrency([1, 2, 3, 4], 2, task)).rejects.toBe(failure);
  });

  it('keeps unaffected workers pulling items after another worker rejects', async () => {
    // Pins the documented contract: rejection does not cancel the pool.
    const completed: number[] = [];
    const task = async (item: number): Promise<void> => {
      if (item === 0) throw new Error('first item failed');
      await ticks(5);
      completed.push(item);
    };

    await expect(mapWithConcurrency([0, 1, 2, 3], 2, task)).rejects.toThrow('first item failed');
    await ticks(20);

    expect(completed).toEqual([1, 2, 3]);
  });
});
