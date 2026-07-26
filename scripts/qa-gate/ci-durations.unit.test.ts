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
});
