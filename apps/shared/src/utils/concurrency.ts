/**
 * Bounded-concurrency helpers shared by the hub and the runtime-facing detection code.
 */

/**
 * Maps `items` through `mapper` with at most `concurrency` calls in flight.
 *
 * - Results keep input order, whatever order the calls finish in.
 * - Items start in input order; a worker takes the next one as soon as it is free.
 * - The first rejection rejects the returned promise. Calls already in flight are
 *   not cancelled and the other workers keep pulling items, so a caller that wants
 *   every item to run to completion must catch inside `mapper`.
 * - A `concurrency` below 1 (or NaN) is treated as 1, and one above `items.length`
 *   starts everything at once. Empty input resolves to `[]` without calling `mapper`.
 *
 * There is no abort signal: a caller that needs to stop early checks its own
 * signal at the top of `mapper`.
 *
 * @example
 * await mapWithConcurrency(['a', 'b', 'c'], 2, async (name) => name.toUpperCase());
 * // ['A', 'B', 'C']
 */
export async function mapWithConcurrency<T, Result>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<Result>
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index] as T);
    }
  };

  // `Math.max(1, NaN)` is NaN, which would spawn no workers and silently skip every item.
  const limit = Number.isNaN(concurrency) ? 1 : Math.max(1, Math.floor(concurrency));
  const workerCount = Math.min(items.length, limit);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
