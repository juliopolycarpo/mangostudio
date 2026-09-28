import { describe, expect, it } from 'bun:test';

import { QA_METRICS_MAX_BYTES, QA_METRICS_FILE_NAME as TS_FILE_NAME } from '../metrics-envelope';
import { buildZip, type ZipEntry } from '../testing/zip-fixture';
import {
  baselineIncompleteReason,
  MAX_METRICS_PAYLOAD_BYTES,
  QA_METRICS_FILE_NAME,
  readMetricsPayload,
  recordedBaseSha,
} from './metrics-archive.mjs';

const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';
const envelopeText = (baseSha: unknown) => JSON.stringify({ schemaVersion: 3, baseSha });
const archiveOf = (content: string, options: Partial<ZipEntry> = {}) =>
  buildZip([{ name: QA_METRICS_FILE_NAME, content, ...options }]);

describe('constants pinning', () => {
  it('mirrors the TypeScript envelope constants', () => {
    expect(QA_METRICS_FILE_NAME).toBe(TS_FILE_NAME);
    expect(MAX_METRICS_PAYLOAD_BYTES).toBe(QA_METRICS_MAX_BYTES);
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
  const complete = (headSha = BASE_SHA, metrics: unknown = { tests: { passed: 1 }, loc: {} }) =>
    archiveOf(JSON.stringify({ headSha, metrics }));

  it('accepts an envelope recorded for the exact sha with every metric measured', () => {
    expect(baselineIncompleteReason(complete(), BASE_SHA)).toBeNull();
  });

  it('does not mistake numeric or list fields named like errors for placeholders', () => {
    const metrics = { tests: { errors: 2, headlines: [{ message: 'x' }] } };
    expect(baselineIncompleteReason(complete(BASE_SHA, metrics), BASE_SHA)).toBeNull();
  });

  it('names nested collector-error placeholders and counts them', () => {
    const metrics = {
      tests: { error: 'no fragment' },
      coverage: { api: { error: 'lcov missing' }, shared: { lines: 1 } },
    };

    expect(baselineIncompleteReason(complete(BASE_SHA, metrics), BASE_SHA)).toBe(
      'qa-metrics artifact is partial: 2 metric(s) failed to collect (metrics/tests, metrics/coverage/api)'
    );
  });

  it('caps how many placeholder paths it lists', () => {
    const metrics = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`m${index}`, { error: 'x' }])
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
