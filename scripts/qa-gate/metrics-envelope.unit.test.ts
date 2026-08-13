import { describe, expect, it } from 'bun:test';

import {
  type ExpectedEnvelope,
  parseQaMetricsEnvelope,
  QA_METRICS_MAX_BYTES,
  QA_METRICS_SCHEMA_VERSION,
  type QaMetricsEnvelope,
} from './metrics-envelope';
import { makeMetrics } from './testing/metrics-fixture';

const HEAD_SHA = `${'a'.repeat(39)}1`;
const BASE_SHA = `${'b'.repeat(39)}2`;
const ADVANCED_BASE_SHA = `${'c'.repeat(39)}3`;

const expected: ExpectedEnvelope = {
  repository: 'mango/studio',
  headSha: HEAD_SHA,
  baseSha: BASE_SHA,
  prNumber: 7,
};

const makeEnvelope = (overrides: Partial<QaMetricsEnvelope> = {}): QaMetricsEnvelope => ({
  schemaVersion: QA_METRICS_SCHEMA_VERSION,
  repository: 'mango/studio',
  prNumber: 7,
  baseSha: BASE_SHA,
  headSha: HEAD_SHA,
  metrics: makeMetrics(HEAD_SHA),
  ...overrides,
});

const parse = (envelope: unknown, expectation: ExpectedEnvelope = expected) =>
  parseQaMetricsEnvelope(JSON.stringify(envelope), expectation);

describe('parseQaMetricsEnvelope', () => {
  it('accepts a well-formed envelope matching the expected provenance', () => {
    const envelope = parse(makeEnvelope());

    expect(envelope.prNumber).toBe(7);
    expect(envelope.metrics.tests).toEqual(makeMetrics(HEAD_SHA).tests);
  });

  it('accepts a baseline envelope with null pr number and base sha', () => {
    const baseline = makeEnvelope({
      prNumber: null,
      baseSha: null,
      headSha: BASE_SHA,
      metrics: makeMetrics(BASE_SHA),
    });

    const envelope = parse(baseline, {
      repository: 'mango/studio',
      headSha: BASE_SHA,
      baseSha: null,
      prNumber: null,
    });

    expect(envelope.headSha).toBe(BASE_SHA);
  });

  it('accepts a head envelope with a stale base sha when enforcement is disabled', () => {
    const envelope = parseQaMetricsEnvelope(
      JSON.stringify(makeEnvelope()),
      {
        ...expected,
        baseSha: ADVANCED_BASE_SHA,
      },
      { enforceBaseSha: false }
    );

    expect(envelope.baseSha).toBe(BASE_SHA);
  });

  it('rejects the same stale head base sha with default enforcement', () => {
    expect(() =>
      parseQaMetricsEnvelope(JSON.stringify(makeEnvelope()), {
        ...expected,
        baseSha: ADVANCED_BASE_SHA,
      })
    ).toThrow('baseSha');
  });

  it('accepts collector-error placeholders for individual metrics', () => {
    const metrics = makeMetrics(HEAD_SHA, {
      tests: { error: 'test metrics fragment not provided' },
      duplication: { error: 'jscpd crashed' },
    });

    expect(parse(makeEnvelope({ metrics })).metrics.tests).toEqual({
      error: 'test metrics fragment not provided',
    });
  });

  it('rejects payloads over the size cap without parsing them', () => {
    const padded = `${JSON.stringify(makeEnvelope())} ${' '.repeat(QA_METRICS_MAX_BYTES)}`;

    expect(() => parseQaMetricsEnvelope(padded, expected)).toThrow('exceeds');
  });

  it('rejects malformed JSON', () => {
    expect(() => parseQaMetricsEnvelope('{not json', expected)).toThrow('not valid JSON');
  });

  it('rejects schema violations: unknown fields, bad shas, wrong shapes', () => {
    expect(() => parse({ ...makeEnvelope(), extra: 'field' })).toThrow('schema validation');
    expect(() => parse(makeEnvelope({ headSha: 'not-a-sha' }), expected)).toThrow(
      'schema validation'
    );
    expect(() =>
      parse(makeEnvelope({ metrics: { ...makeMetrics(HEAD_SHA), tests: 42 } as never }))
    ).toThrow('schema validation');
  });

  it('names the failing location in a schema rejection', () => {
    // Rendered as `${path || '/'}: ${message}` from the first schema error.
    // The publisher runs against an untrusted artifact, so this pointer is the
    // only description anyone gets of why a payload was refused.
    expect(() => parse({ ...makeEnvelope(), extra: 'field' })).toThrow(/\(\/extra: .+\)/);
    expect(() => parse(makeEnvelope({ headSha: 'not-a-sha' }))).toThrow(/\(\/headSha: .+\)/);
    expect(() =>
      parse(makeEnvelope({ metrics: { ...makeMetrics(HEAD_SHA), tests: 42 } as never }))
    ).toThrow(/\(\/metrics\/tests: .+\)/);
  });

  it('rejects provenance mismatches against trusted expectations', () => {
    expect(() => parse(makeEnvelope({ repository: 'evil/fork' }))).toThrow('repository');
    expect(() => parse(makeEnvelope({ headSha: BASE_SHA }))).toThrow('headSha');
    expect(() => parse(makeEnvelope({ baseSha: null }))).toThrow('baseSha');
    expect(() => parse(makeEnvelope({ prNumber: 8 }))).toThrow('prNumber');
  });

  it('rejects a schema version drift', () => {
    expect(() => parse(makeEnvelope({ schemaVersion: QA_METRICS_SCHEMA_VERSION + 1 }))).toThrow(
      'schema version'
    );
  });
});
