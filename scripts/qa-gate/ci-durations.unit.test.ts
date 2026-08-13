import { describe, expect, it } from 'bun:test';

import { parseCiDurationComparison } from './ci-durations';
import { makeCiDurations } from './testing/metrics-fixture';

describe('parseCiDurationComparison', () => {
  it('accepts the privileged Actions API timing handoff', () => {
    const durations = makeCiDurations();

    expect(parseCiDurationComparison(JSON.stringify(durations))).toEqual(durations);
  });

  it('rejects malformed timing data before rendering', () => {
    const malformed = {
      ...makeCiDurations(),
      head: { runId: 2, error: null, jobs: [{ name: 'Test' }] },
    };

    expect(() => parseCiDurationComparison(JSON.stringify(malformed))).toThrow(
      'failed schema validation'
    );
  });

  it('names the failing location in the rejection message', () => {
    // The message is rendered from the first schema error as
    // `${path || '/'}: ${message}`. That pointer is the whole diagnostic value
    // of the failure — a maintainer reading a red CI job has the raw payload
    // nowhere else — so it is asserted as text rather than through the error
    // object the renderer happens to iterate today.
    const malformed = {
      ...makeCiDurations(),
      head: { runId: 2, error: null, jobs: [{ name: 'Test' }] },
    };

    expect(() => parseCiDurationComparison(JSON.stringify(malformed))).toThrow(
      /\(\/head\/jobs\/0\/status: .+\)/
    );
  });

  it('names the root when the violation is at the top level', () => {
    expect(() =>
      parseCiDurationComparison(JSON.stringify({ ...makeCiDurations(), extra: 1 }))
    ).toThrow(/\(\/extra: .+\)/);
    expect(() => parseCiDurationComparison(JSON.stringify([]))).toThrow(/\(\/: .+\)/);
  });
});
