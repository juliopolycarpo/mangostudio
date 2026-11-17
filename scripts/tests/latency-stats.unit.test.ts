import { describe, expect, it } from 'bun:test';

import { nearestRank, pairedComparison, summarizeLatencies } from '../lib/latency-stats';

describe('scripts/lib/latency-stats', () => {
  it('summarizes an odd sample set regardless of input order', () => {
    expect(summarizeLatencies([12.44, 10.1, 11.7])).toEqual({
      n: 3,
      min: 10.1,
      median: 11.7,
      p95: 12.4,
      max: 12.4,
    });
  });

  it('averages the two middle samples for an even set', () => {
    expect(summarizeLatencies([4, 1, 3, 2]).median).toBe(2.5);
  });

  it('takes p95 as a measured sample, not an interpolation', () => {
    const samples = Array.from({ length: 20 }, (_, index) => index + 1);
    // ceil(0.95 * 20) = 19th of 20.
    expect(summarizeLatencies(samples).p95).toBe(19);
    expect(nearestRank([5], 0.95)).toBe(5);
  });

  it('refuses an empty sample set instead of reporting zeros', () => {
    expect(() => summarizeLatencies([])).toThrow(
      'expected at least one timing sample | received: []'
    );
  });

  it('names a sample that is not a duration', () => {
    expect(() => summarizeLatencies([3, Number.NaN])).toThrow(
      'expected finite, non-negative timing samples in ms | received: NaN in [3, NaN]'
    );
  });

  it('pairs samples by run and counts which side won each pair', () => {
    expect(pairedComparison([10, 10, 10, 10], [11, 9, 12, 10])).toEqual({
      pairs: 4,
      medianDelta: 0.5,
      candidateFaster: 1,
      baselineFaster: 2,
      ties: 1,
    });
  });

  it('refuses sample sets that cannot be paired', () => {
    expect(() => pairedComparison([1, 2], [1])).toThrow(
      'expected two non-empty sample sets of equal length | received: 2 baseline and 1 candidate samples'
    );
    expect(() => pairedComparison([1], [Number.NaN])).toThrow(
      'expected finite samples | received: baseline [1], candidate [NaN]'
    );
  });
});
