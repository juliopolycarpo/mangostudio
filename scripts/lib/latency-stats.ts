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

export interface PairedComparison {
  readonly pairs: number;
  /** Median of `candidate - baseline` per pair; positive means the candidate was slower. */
  readonly medianDelta: number;
  readonly candidateFaster: number;
  readonly baselineFaster: number;
  readonly ties: number;
}

/**
 * Compares two sample sets run by run. Sample `i` of each set was measured in the
 * same interleaved round, so the per-pair difference cancels slow drift in host
 * load that two independent medians would absorb as signal.
 *
 * @example
 * pairedComparison([10, 10, 10], [11, 9, 12]); // medianDelta 1, candidateFaster 1, baselineFaster 2
 */
export function pairedComparison(
  baseline: readonly number[],
  candidate: readonly number[]
): PairedComparison {
  if (baseline.length === 0 || baseline.length !== candidate.length) {
    throw new Error(
      `expected two non-empty sample sets of equal length | received: ${baseline.length} baseline and ${candidate.length} candidate samples`
    );
  }
  const deltas = candidate.map((value, index) => value - (baseline[index] as number));
  if (deltas.some((delta) => !Number.isFinite(delta))) {
    throw new Error(
      `expected finite samples | received: baseline [${baseline.join(', ')}], candidate [${candidate.join(', ')}]`
    );
  }
  const sorted = [...deltas].sort((left, right) => left - right);
  return {
    pairs: deltas.length,
    medianDelta: Math.round(medianOf(sorted) * 1000) / 1000,
    candidateFaster: deltas.filter((delta) => delta < 0).length,
    baselineFaster: deltas.filter((delta) => delta > 0).length,
    ties: deltas.filter((delta) => delta === 0).length,
  };
}
