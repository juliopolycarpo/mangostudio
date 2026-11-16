// Run order for interleaved A/B benchmarks.

/**
 * The candidates in the order run `run` should measure them.
 *
 * Plain interleaving (A B A B) always runs the first candidate first, so a
 * cache or CPU-frequency effect of the previous run lands on the same side
 * every time. Rotating the order by one position per run makes every candidate
 * lead once per cycle of `candidates.length` runs. For two candidates that is
 * ABBA (A B, B A, A B, ...); for three it is ABC, BCA, CAB.
 *
 * The index is the measured run number, so the first measured run always starts
 * with the first candidate. Warm-up runs pass a negative index and get a
 * rotation of their own, which the measured order does not depend on.
 *
 * @example
 * rotatedOrder(['base', 'head'], 0); // ['base', 'head']
 * rotatedOrder(['base', 'head'], 1); // ['head', 'base']
 * rotatedOrder(['a', 'b', 'c'], 1); // ['b', 'c', 'a']
 */
export function rotatedOrder<T>(candidates: readonly T[], run: number): readonly T[] {
  if (!Number.isInteger(run)) {
    throw new Error(`expected an integer run index | received: ${String(run)}`);
  }
  if (candidates.length === 0) return candidates;
  const offset = ((run % candidates.length) + candidates.length) % candidates.length;
  return [...candidates.slice(offset), ...candidates.slice(0, offset)];
}
