import { describe, expect, it } from 'bun:test';

import {
  QA_METRICS_MAX_BYTES,
  QA_METRICS_SCHEMA_VERSION,
  QA_METRICS_FILE_NAME as TS_FILE_NAME,
} from '../metrics-envelope';
import { buildZip, type ZipEntry } from '../testing/zip-fixture';
import {
  QA_METRICS_SCHEMA_VERSION as ARCHIVE_SCHEMA_VERSION,
  baselineIncompleteReason,
  baselineVerdict,
  MAX_METRICS_PAYLOAD_BYTES,
  QA_METRICS_FILE_NAME,
  readMetricsPayload,
  recordedBaseSha,
} from './metrics-archive.mjs';

const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';
const envelopeText = (baseSha: unknown) =>
  JSON.stringify({ schemaVersion: QA_METRICS_SCHEMA_VERSION, baseSha });
const archiveOf = (content: string, options: Partial<ZipEntry> = {}) =>
  buildZip([{ name: QA_METRICS_FILE_NAME, content, ...options }]);

describe('constants pinning', () => {
  it('mirrors the TypeScript envelope constants', () => {
    expect(QA_METRICS_FILE_NAME).toBe(TS_FILE_NAME);
    expect(MAX_METRICS_PAYLOAD_BYTES).toBe(QA_METRICS_MAX_BYTES);
    expect(ARCHIVE_SCHEMA_VERSION).toBe(QA_METRICS_SCHEMA_VERSION);
  });
});

describe('readMetricsPayload', () => {
  it('inflates a deflated entry', () => {
    expect(readMetricsPayload(archiveOf('{"a":1}'))).toBe('{"a":1}');
  });

  it('reads a stored entry', () => {
    expect(readMetricsPayload(archiveOf('{"a":1}', { method: 'stored' }))).toBe('{"a":1}');
  });

  it('trusts central-directory sizes when the local header carries zeros', () => {
    expect(readMetricsPayload(archiveOf('{"a":1}', { dataDescriptor: true }))).toBe('{"a":1}');
  });

  it('finds the entry among others', () => {
    const archive = buildZip([
      { name: 'other.txt', content: 'x' },
      { name: QA_METRICS_FILE_NAME, content: '{"b":2}' },
    ]);
    expect(readMetricsPayload(archive)).toBe('{"b":2}');
  });

  it('rejects an archive with two metrics entries instead of trusting the first', () => {
    const archive = buildZip([
      { name: QA_METRICS_FILE_NAME, content: '{"a":1}' },
      { name: QA_METRICS_FILE_NAME, content: '{"a":2}' },
    ]);
    expect(() => readMetricsPayload(archive)).toThrow('more than one metrics.json entry');
  });

  it('rejects an archive without the metrics entry, naming the entry', () => {
    const archive = buildZip([{ name: 'other.txt', content: 'x' }]);
    expect(() => readMetricsPayload(archive)).toThrow('archive has no metrics.json entry');
  });

  it('rejects bytes that are not a zip archive', () => {
    expect(() => readMetricsPayload(new Uint8Array(30))).toThrow('end-of-central-directory');
  });

  it('rejects an archive shorter than a zip end record', () => {
    expect(() => readMetricsPayload(new Uint8Array([123]))).toThrow('end-of-central-directory');
  });

  it('rejects a truncated archive', () => {
    const archive = archiveOf('{"a":1}');
    expect(() => readMetricsPayload(archive.subarray(0, archive.length - 30))).toThrow();
  });

  it('rejects an unsupported compression method with its number', () => {
    expect(() => readMetricsPayload(archiveOf('{}', { rawMethod: 12 }))).toThrow(
      'compression method 12'
    );
  });

  it('rejects a payload that declares more than the cap', () => {
    const oversized = ' '.repeat(MAX_METRICS_PAYLOAD_BYTES + 1);
    expect(() => readMetricsPayload(archiveOf(oversized))).toThrow('at most');
  });

  it('stops inflating a payload that understates its size past the cap', () => {
    const bomb = archiveOf(' '.repeat(MAX_METRICS_PAYLOAD_BYTES + 1), { declaredSize: 10 });
    expect(() => readMetricsPayload(bomb)).toThrow('larger than');
  });
});

describe('recordedBaseSha', () => {
  it('returns the recorded 40-hex base sha', () => {
    expect(recordedBaseSha(archiveOf(envelopeText(BASE_SHA)))).toEqual({
      sha: BASE_SHA,
      reason: null,
    });
  });

  it('is unavailable without an archive', () => {
    expect(recordedBaseSha(null)).toEqual({
      sha: null,
      reason: 'head qa-metrics artifact is unavailable',
    });
  });

  it('is unavailable for an unreadable archive', () => {
    const result = recordedBaseSha(new Uint8Array([123]));
    expect(result.sha).toBeNull();
    expect(result.reason).toContain('unreadable');
  });

  it('is unavailable for a truncated JSON payload', () => {
    const result = recordedBaseSha(archiveOf(envelopeText(BASE_SHA).slice(0, 20)));
    expect(result.sha).toBeNull();
    expect(result.reason).toContain('unreadable');
  });

  it.each([
    ['null', null],
    ['missing', undefined],
    ['uppercase', BASE_SHA.toUpperCase()],
    ['short', BASE_SHA.slice(0, 39)],
    ['option-like', '--output=/etc/passwd'],
    ['a number', 7],
  ])('is unavailable for a %s baseSha and names the value', (_label, value) => {
    const result = recordedBaseSha(archiveOf(envelopeText(value)));
    expect(result.sha).toBeNull();
    expect(result.reason).toContain('40-character lowercase hex SHA');
  });

  it('bounds the untrusted value echoed in the reason', () => {
    const result = recordedBaseSha(archiveOf(envelopeText('x'.repeat(5000))));
    expect((result.reason ?? '').length).toBeLessThan(200);
  });
});

describe('baselineIncompleteReason', () => {
  const measured = (value: unknown) => ({ state: 'measured', value });
  const healthyMetrics = () => ({
    sha: BASE_SHA,
    components: [
      {
        id: 'workspace:@x/api',
        root: 'apps/api',
        loc: measured({ production: { files: 1 } }),
        coverage: measured({ lines: { total: 1, covered: 1, pct: 100 } }),
        tsErrors: measured(0),
      },
      {
        id: 'crate:beta',
        root: 'crates/beta',
        loc: measured({ production: { files: 1 } }),
        coverage: { state: 'unsupported', reasons: ['no coverage lane is wired'] },
        tsErrors: { state: 'unsupported', reasons: ['no type-check is defined'] },
      },
    ],
    tests: measured({ exitCode: 0, passed: 1 }),
    circularDeps: measured(0),
  });
  const complete = (
    headSha = BASE_SHA,
    metrics: unknown = healthyMetrics(),
    schemaVersion: unknown = QA_METRICS_SCHEMA_VERSION
  ) => archiveOf(JSON.stringify({ schemaVersion, headSha, metrics }));

  it('accepts an envelope recorded for the exact sha with every metric measured or unsupported', () => {
    expect(baselineIncompleteReason(complete(), BASE_SHA)).toBeNull();
  });

  it('does not mistake fields named like errors or state inside a measured value for measurements', () => {
    const metrics = {
      ...healthyMetrics(),
      tests: measured({ errors: 2, headlines: [{ message: 'x' }], state: 'unavailable' }),
    };
    expect(baselineIncompleteReason(complete(BASE_SHA, metrics), BASE_SHA)).toBeNull();
  });

  it.each(['unavailable', 'partial', 'stale'])(
    'treats a %s metric as an incomplete baseline, naming its path and state',
    (state) => {
      const metrics = { ...healthyMetrics(), tests: { state, reasons: ['why'] } };

      expect(baselineIncompleteReason(complete(BASE_SHA, metrics), BASE_SHA)).toBe(
        `qa-metrics artifact is partial: 1 metric(s) not fully measured (metrics/tests=${state})`
      );
    }
  );

  it('names nested per-component states by component root and counts them', () => {
    const metrics = healthyMetrics();
    metrics.components[0].coverage = { state: 'unavailable', reasons: ['lcov missing'] } as never;
    metrics.components[1].loc = { state: 'partial', reasons: ['a.rs unreadable'] } as never;
    metrics.tests = { state: 'stale', reasons: ['other commit'] } as never;

    expect(baselineIncompleteReason(complete(BASE_SHA, metrics), BASE_SHA)).toBe(
      'qa-metrics artifact is partial: 3 metric(s) not fully measured (metrics/components/apps/api/coverage=unavailable, metrics/components/crates/beta/loc=partial, metrics/tests=stale)'
    );
  });

  it('does not treat unsupported as incomplete', () => {
    const metrics = { ...healthyMetrics(), circularDeps: { state: 'unsupported', reasons: ['x'] } };

    expect(baselineIncompleteReason(complete(BASE_SHA, metrics), BASE_SHA)).toBeNull();
  });

  it('rejects an unknown state rather than trusting it', () => {
    const metrics = { ...healthyMetrics(), tests: { state: 'success', value: 1 } };

    expect(baselineIncompleteReason(complete(BASE_SHA, metrics), BASE_SHA)).toBe(
      'qa-metrics artifact is partial: 1 metric(s) not fully measured (metrics/tests=success)'
    );
  });

  it('rejects an envelope with no metrics object', () => {
    expect(baselineIncompleteReason(complete(BASE_SHA, null), BASE_SHA)).toContain(
      'has no metrics object'
    );
  });

  it('caps how many paths it lists', () => {
    const metrics = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        `m${index}`,
        { state: 'unavailable', reasons: ['x'] },
      ])
    );
    const reason = baselineIncompleteReason(complete(BASE_SHA, metrics), BASE_SHA) ?? '';

    expect(reason).toContain('9 metric(s)');
    expect(reason).not.toContain('metrics/m5');
  });

  it('rejects an envelope recorded for another sha', () => {
    expect(baselineIncompleteReason(complete(`${'d'.repeat(40)}`), BASE_SHA)).toContain(
      `does not match base ${BASE_SHA}`
    );
  });

  it('rejects unreadable bytes and invalid JSON', () => {
    expect(baselineIncompleteReason(new Uint8Array([123]), BASE_SHA)).toContain('unreadable');
    expect(baselineIncompleteReason(archiveOf('{bad'), BASE_SHA)).toContain('unreadable');
  });
});

describe('baselineVerdict: other schema versions are incomparable, not unavailable', () => {
  const v3 = (metrics: unknown = { tests: { passed: 1 } }) =>
    archiveOf(JSON.stringify({ schemaVersion: 3, headSha: BASE_SHA, metrics }));

  it('reports a v3 baseline as incomparable with both versions named', () => {
    const verdict = baselineVerdict(v3(), BASE_SHA);

    expect(verdict.incomparable).toBe(true);
    expect(verdict.reason).toBe(
      `qa-metrics artifact is incomparable: recorded under schema version 3, expected ${QA_METRICS_SCHEMA_VERSION}; older envelopes are historical and are not read`
    );
    expect(verdict.reason).not.toContain('no successful');
  });

  it('decides on the version before looking at the body or the sha', () => {
    const archive = archiveOf(JSON.stringify({ schemaVersion: 3, headSha: 'nope', metrics: 5 }));

    expect(baselineVerdict(archive, BASE_SHA).incomparable).toBe(true);
  });

  it('reports a future version as incomparable too', () => {
    const future = archiveOf(JSON.stringify({ schemaVersion: 5, headSha: BASE_SHA }));

    expect(baselineVerdict(future, BASE_SHA).incomparable).toBe(true);
    expect(baselineVerdict(future, BASE_SHA).reason).toContain('schema version 5');
  });

  it('a missing or non-integer version is a plain incomplete artifact, not incomparable', () => {
    for (const schemaVersion of [undefined, '4', 4.5, null]) {
      const archive = archiveOf(JSON.stringify({ schemaVersion, headSha: BASE_SHA, metrics: {} }));
      const verdict = baselineVerdict(archive, BASE_SHA);

      expect(verdict.incomparable).toBe(false);
      expect(verdict.reason).toContain('schemaVersion');
    }
  });

  it('baselineIncompleteReason returns the same incomparable reason', () => {
    expect(baselineIncompleteReason(v3(), BASE_SHA)).toBe(baselineVerdict(v3(), BASE_SHA).reason);
  });

  it('a complete v4 baseline is neither incomparable nor incomplete', () => {
    const archive = archiveOf(
      JSON.stringify({
        schemaVersion: QA_METRICS_SCHEMA_VERSION,
        headSha: BASE_SHA,
        metrics: { tests: { state: 'measured', value: 1 } },
      })
    );

    expect(baselineVerdict(archive, BASE_SHA)).toEqual({ reason: null, incomparable: false });
  });
});
