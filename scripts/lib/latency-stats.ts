// Order statistics for a small set of timing samples.
//
// Benchmarks here take tens of samples, not thousands, so the percentile is
// nearest-rank: it always names a sample that was actually measured rather than
// an interpolated time no run ever took.

export interface LatencySummary {
  readonly n: number;
  readonly min: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
}

/**
 * Summarizes timing samples as min / median / p95 / max, rounded to 0.1 ms.
 *
 * Throws on an empty or non-finite sample set: a summary of nothing would print
 * as a row of zeros, which reads like a very fast runtime.
 *
 * @example
 * summarizeLatencies([12.4, 10.1, 11.7]); // { n: 3, min: 10.1, median: 11.7, p95: 12.4, max: 12.4 }
 */
export function summarizeLatencies(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) {
    throw new Error('expected at least one timing sample | received: []');
  }
  const invalid = samples.find((sample) => !Number.isFinite(sample) || sample < 0);
  if (invalid !== undefined) {
    throw new Error(
      `expected finite, non-negative timing samples in ms | received: ${String(invalid)} in [${samples.join(', ')}]`
    );
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    n: sorted.length,
    min: round(sorted[0] as number),
    median: round(medianOf(sorted)),
    p95: round(nearestRank(sorted, 0.95)),
    max: round(sorted[sorted.length - 1] as number),
  };
}

/**
 * The nearest-rank percentile of already-sorted samples.
 *
 * @example
 * nearestRank([1, 2, 3, 4], 0.5); // 2
 */
export function nearestRank(sorted: readonly number[], quantile: number): number {
  const rank = Math.max(1, Math.ceil(quantile * sorted.length));
  return sorted[rank - 1] as number;
}

function medianOf(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
