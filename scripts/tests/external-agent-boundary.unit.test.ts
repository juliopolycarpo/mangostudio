import { describe, expect, it } from 'bun:test';
import {
  BOUNDARY_CASES,
  parseBoundarySample,
  summarizeBoundarySamples,
} from '../bench/external-agent-boundary';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const sample = {
  case: 'ordinary',
  operation: 'fingerprint',
  sourceSha: SHA,
  iterations: 10,
  elapsedNs: 500,
  inputBytes: 12,
  encodedAttachmentBytes: 0,
  decodedAttachmentBytes: 0,
  attachmentCount: 0,
  serializedBytes: 120,
} as const;
const receipt = (value: unknown) => `EXTERNAL_AGENT_BOUNDARY_SAMPLE ${JSON.stringify(value)}\n`;

describe('owned boundary benchmark receipts', () => {
  it('parses exactly one measured sample bound to the compiled source', () => {
    expect(parseBoundarySample(`running 1 test\n${receipt(sample)}test result: ok\n`, SHA)).toEqual(
      sample
    );
  });
  it('accepts libtest printing the test name before uncaptured output', () => {
    expect(
      parseBoundarySample(`running 1 test\ntest test_name ... ${receipt(sample)}ok\n`, SHA)
    ).toEqual(sample);
  });
  it.each([
    ['missing', 'running 0 tests'],
    ['duplicate', receipt(sample).repeat(2)],
    ['non-object', receipt(null)],
    ['source mismatch', receipt({ ...sample, sourceSha: 'other' })],
    ['zero iterations', receipt({ ...sample, iterations: 0 })],
    ['negative duration', receipt({ ...sample, elapsedNs: -1 })],
    ['missing bytes', receipt({ ...sample, inputBytes: undefined })],
    ['fractional iterations', receipt({ ...sample, iterations: 1.5 })],
    ['unknown operation', receipt({ ...sample, operation: 'network' })],
    ['missing name', receipt({ ...sample, case: undefined })],
    ['invalid capacity', receipt({ ...sample, sourceCapacity: 1 })],
  ])('rejects a %s receipt without substituting healthy zeros', (_label, stdout) => {
    expect(() => parseBoundarySample(stdout, SHA)).toThrow();
  });
  it('accepts and preserves the capacity fixture metadata', () => {
    expect(
      parseBoundarySample(receipt({ ...sample, sourceCapacity: 48 }), SHA).sourceCapacity
    ).toBe(48);
  });
  it('reports exact medians and nearest-rank p95 without losing sub-millisecond data', () => {
    expect(
      summarizeBoundarySamples([
        { ns: 25, peakRssKiB: 100 },
        { ns: 1, peakRssKiB: null },
        { ns: 3, peakRssKiB: 110 },
        { ns: 2, peakRssKiB: 120 },
      ])
    ).toEqual({
      count: 4,
      medianNs: 2.5,
      p95Ns: 25,
      minNs: 1,
      maxNs: 25,
      rssSamples: 3,
      medianPeakRssKiB: 110,
      p95PeakRssKiB: 120,
    });
  });
  it('leaves unsupported memory measurements null', () => {
    expect(summarizeBoundarySamples([{ ns: 100, peakRssKiB: null }]).medianPeakRssKiB).toBeNull();
  });
  it.each([
    { samples: [] },
    { samples: [{ ns: NaN, peakRssKiB: null }] },
    { samples: [{ ns: -1, peakRssKiB: null }] },
    { samples: [{ ns: 1, peakRssKiB: 0 }] },
    { samples: [{ ns: 1, peakRssKiB: Infinity }] },
  ])('rejects invalid summary input %#', ({ samples }) => {
    expect(() => summarizeBoundarySamples(samples)).toThrow();
  });
  it('includes unique registered fingerprint, request and event fixtures', () => {
    expect(BOUNDARY_CASES).toHaveLength(19);
    expect(new Set(BOUNDARY_CASES).size).toBe(19);
    expect(BOUNDARY_CASES.filter((test) => test.includes('fingerprint_'))).toHaveLength(5);
    expect(BOUNDARY_CASES.filter((test) => test.includes('request_'))).toHaveLength(5);
  });
});
