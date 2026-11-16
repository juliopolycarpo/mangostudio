// Run order for interleaved A/B benchmarks.

/**
 * The candidates in the order run `run` should measure them (ABBA).
 *
 * Plain interleaving (A B A B) always runs the first candidate first, so a
 * cache or CPU-frequency effect of the previous run lands on the same side
 * every time. Reversing the order on every odd run alternates which candidate
 * pays for it, so neither side is systematically favoured and drift in machine
 * load hits every candidate alike.
 *
 * @example
 * abbaOrder(['base', 'head'], 0); // ['base', 'head']
 * abbaOrder(['base', 'head'], 1); // ['head', 'base']
 */
export function abbaOrder<T>(candidates: readonly T[], run: number): readonly T[] {
  if (!Number.isInteger(run) || run < 0) {
    throw new Error(`expected a non-negative integer run index | received: ${String(run)}`);
  }
  return run % 2 === 0 ? candidates : [...candidates].reverse();
}
