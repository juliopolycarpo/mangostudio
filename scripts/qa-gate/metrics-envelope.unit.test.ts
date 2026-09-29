import { describe, expect, it } from 'bun:test';
import type { TestSuiteStats } from './collect/types';
import {
  type ExpectedEnvelope,
  IncomparableEnvelopeError,
  parseQaMetricsEnvelope,
  QA_METRICS_MAX_BYTES,
  QA_METRICS_SCHEMA_VERSION,
  type QaMetricsEnvelope,
  serializeQaMetricsEnvelope,
} from './metrics-envelope';
import {
  absentFromProducer,
  type DataState,
  type Measurement,
  measured,
  measuredValue,
  partial,
  stale,
  unavailable,
  unsupported,
} from './model/states';
import {
  makeComponent,
  makeComponents,
  makeCoverageSummary,
  makeLocStats,
  makeMetrics,
  makeRustCoverageSummary,
} from './testing/metrics-fixture';

const HEAD_SHA = `${'a'.repeat(39)}1`;
const BASE_SHA = `${'b'.repeat(39)}2`;
const ADVANCED_BASE_SHA = `${'c'.repeat(39)}3`;

const PASSING_TESTS: TestSuiteStats = {
  exitCode: 0,
  durationSeconds: 1,
  passed: 3,
  root: 0,
  frontend: 3,
  api: 0,
  shared: 0,
};

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
  provenance: {
    sourceSha: HEAD_SHA,
    producer: { name: 'mangostudio/qa-gate-collect', version: '0.1.1' },
    runId: 4242,
    runAttempt: 1,
  },
  metrics: makeMetrics(HEAD_SHA),
  ...overrides,
});

const parse = (envelope: unknown, expectation: ExpectedEnvelope = expected) =>
  parseQaMetricsEnvelope(JSON.stringify(envelope), expectation);

/** Envelope whose first component's cells are replaced. */
const withComponent = (patch: Parameters<typeof makeComponent>[1]): QaMetricsEnvelope =>
  makeEnvelope({
    metrics: makeMetrics(HEAD_SHA, {
      components: [makeComponent('apps/frontend', patch), ...makeComponents().slice(1)],
    }),
  });

describe('parseQaMetricsEnvelope', () => {
  it('accepts a well-formed envelope matching the expected provenance', () => {
    const envelope = parse(makeEnvelope());

    expect(envelope.prNumber).toBe(7);
    expect(envelope.provenance.runId).toBe(4242);
    expect(envelope.metrics.tests).toEqual(makeMetrics(HEAD_SHA).tests);
  });

  it('accepts optional failure signals on the tests object and still accepts a green payload without them', () => {
    const green = parse(makeEnvelope());
    expect(green.metrics.tests).toEqual(makeMetrics(HEAD_SHA).tests);

    const failingTests = {
      exitCode: 1,
      durationSeconds: 165,
      passed: 1150,
      root: 0,
      frontend: 1150,
      api: 0,
      shared: 0,
      failed: 0,
      failedFiles: 0,
      errors: 2,
      headlines: [
        {
          message: 'ReferenceError: window is not defined',
          originatedIn: 'tests/unit/features/library/backup-list.test.tsx',
        },
      ],
      parseMiss: false,
    };
    const envelope = parse(
      makeEnvelope({ metrics: makeMetrics(HEAD_SHA, { tests: measured(failingTests) }) })
    );
    expect(envelope.metrics.tests).toEqual(measured(failingTests));
  });

  it('accepts a baseline envelope with null pr number and base sha', () => {
    const baseline = makeEnvelope({
      prNumber: null,
      baseSha: null,
      headSha: BASE_SHA,
      provenance: { ...makeEnvelope().provenance, sourceSha: BASE_SHA },
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

  it('accepts explicit-state placeholders for individual metrics', () => {
    const metrics = makeMetrics(HEAD_SHA, {
      tests: unavailable('test metrics fragment not provided'),
      duplication: unavailable('jscpd crashed'),
    });

    expect(parse(makeEnvelope({ metrics })).metrics.tests).toEqual({
      state: 'unavailable',
      reasons: ['test metrics fragment not provided'],
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
});

describe('schema version: v3 is historical and incomparable', () => {
  const v3Envelope = {
    schemaVersion: 3,
    repository: 'mango/studio',
    prNumber: null,
    baseSha: null,
    headSha: BASE_SHA,
    metrics: { sha: BASE_SHA, loc: { frontend: { files: 1, code: 1 } } },
  };

  it('reports a v3 envelope as incomparable, naming both versions', () => {
    let thrown: unknown;
    try {
      parse(v3Envelope);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(IncomparableEnvelopeError);
    expect((thrown as IncomparableEnvelopeError).foundVersion).toBe(3);
    expect((thrown as Error).message).toContain('schema version 3');
    expect((thrown as Error).message).toContain(`expected ${QA_METRICS_SCHEMA_VERSION}`);
  });

  it('never reads a v3 body: incomparable is decided before any shape check', () => {
    expect(() => parse({ ...v3Envelope, metrics: 'garbage' })).toThrow(IncomparableEnvelopeError);
  });

  it('reports a future version as incomparable too', () => {
    expect(() =>
      parse(makeEnvelope({ schemaVersion: QA_METRICS_SCHEMA_VERSION + 1 } as never))
    ).toThrow(IncomparableEnvelopeError);
  });

  it('still fails schema validation, not incomparable, when the version is missing', () => {
    const { schemaVersion: _omitted, ...withoutVersion } = makeEnvelope();

    expect(() => parse(withoutVersion)).toThrow('schema validation');
  });
});

describe('v4 schema: counts, consistency and provenance', () => {
  it('rejects negative counts', () => {
    const negativeLoc = makeLocStats();
    negativeLoc.production.files = -1;

    expect(() => parse(withComponent({ loc: measured(negativeLoc) }))).toThrow(
      /\/metrics\/components\/0\/loc\//
    );
    expect(() =>
      parse(
        makeEnvelope({
          metrics: makeMetrics(HEAD_SHA, {
            tests: measured({ ...PASSING_TESTS, passed: -3 }),
          }),
        })
      )
    ).toThrow('schema validation');
    expect(() => parse(withComponent({ tsErrors: measured(-1) }))).toThrow('schema validation');
  });

  it('rejects covered greater than total, naming the bucket', () => {
    const summary = makeCoverageSummary();
    summary.lines = { total: 10, covered: 12, pct: 100 };

    expect(() => parse(withComponent({ coverage: measured(summary) }))).toThrow(
      /covered=12 total=10/
    );
  });

  it('accepts a region bucket, and an envelope recorded before regions existed', () => {
    const rust = parse(withComponent({ coverage: measured(makeRustCoverageSummary(90)) }));
    expect(measuredValue(rust.metrics.components[0].coverage)?.regions?.pct).toBe(90);

    const beforeRegions = parse(withComponent({ coverage: measured(makeCoverageSummary(90)) }));
    expect(measuredValue(beforeRegions.metrics.components[0].coverage)?.regions).toBeUndefined();
  });

  it('rejects a region bucket that covers more than it holds, naming the bucket', () => {
    const summary = makeRustCoverageSummary();
    summary.regions = { total: 10, covered: 12, pct: 100 };

    expect(() => parse(withComponent({ coverage: measured(summary) }))).toThrow(
      /covered=12 total=10/
    );
  });

  it('treats a zero denominator as n/a: pct null is accepted, a percentage is rejected', () => {
    const naSummary = makeCoverageSummary();
    naSummary.branches = { total: 0, covered: 0, pct: null };
    const parsed = parse(withComponent({ coverage: measured(naSummary) }));
    expect(measuredValue(parsed.metrics.components[0].coverage)?.branches?.pct).toBeNull();

    for (const pct of [0, 100]) {
      const zeroWithPct = makeCoverageSummary();
      zeroWithPct.branches = { total: 0, covered: 0, pct };
      expect(() => parse(withComponent({ coverage: measured(zeroWithPct) }))).toThrow(
        /covered=0 total=0/
      );
    }
  });

  it('rejects a null pct on a non-zero denominator and a pct that contradicts the counts', () => {
    const nullPct = makeCoverageSummary();
    nullPct.lines = { total: 10, covered: 5, pct: null };
    expect(() => parse(withComponent({ coverage: measured(nullPct) }))).toThrow(
      /covered=5 total=10/
    );

    const wrongPct = makeCoverageSummary();
    wrongPct.lines = { total: 10, covered: 5, pct: 80 };
    expect(() => parse(withComponent({ coverage: measured(wrongPct) }))).toThrow(
      /covered=5 total=10/
    );
  });

  it('rejects LoC that do not add up and lines without files', () => {
    const wrongTotal = makeLocStats();
    wrongTotal.production.total = 99;
    expect(() => parse(withComponent({ loc: measured(wrongTotal) }))).toThrow(/total=99/);

    const linesWithoutFiles = makeLocStats();
    linesWithoutFiles.test = { files: 0, code: 5, comment: 0, blank: 0, total: 5 };
    expect(() => parse(withComponent({ loc: measured(linesWithoutFiles) }))).toThrow(/files=0/);
  });

  it('rejects unknown states and states carrying the wrong fields', () => {
    const unknownState = { state: 'success', value: 1 } as never;
    expect(() => parse(withComponent({ tsErrors: unknownState }))).toThrow('schema validation');
    // A measured cell must carry its value; an unavailable one must not carry one.
    expect(() => parse(withComponent({ tsErrors: { state: 'measured' } as never }))).toThrow(
      'schema validation'
    );
    expect(() =>
      parse(
        withComponent({ tsErrors: { state: 'unavailable', reasons: ['x'], value: 0 } as never })
      )
    ).toThrow('schema validation');
    expect(() =>
      parse(withComponent({ tsErrors: { state: 'unavailable', reasons: [] } as never }))
    ).toThrow('schema validation');
  });

  it('rejects missing or malformed provenance', () => {
    const { provenance: _omitted, ...withoutProvenance } = makeEnvelope();
    expect(() => parse(withoutProvenance)).toThrow(/\(\/: .*provenance|schema validation/);

    const provenance = makeEnvelope().provenance;
    for (const broken of [
      { ...provenance, sourceSha: 'unknown' },
      { ...provenance, runId: 0 },
      { ...provenance, runAttempt: 1.5 },
      { ...provenance, producer: { name: '', version: '1' } },
      { ...provenance, producer: { name: 'qa', version: '' } },
    ]) {
      expect(() => parse(makeEnvelope({ provenance: broken }))).toThrow('schema validation');
    }
    const { runId: _runId, ...withoutRunId } = provenance;
    expect(() => parse(makeEnvelope({ provenance: withoutRunId as never }))).toThrow(
      'schema validation'
    );
  });

  it('rejects metrics measured at a different commit than the provenance claims', () => {
    const envelope = makeEnvelope({
      provenance: { ...makeEnvelope().provenance, sourceSha: BASE_SHA },
    });

    expect(() => parse(envelope)).toThrow(/differs from provenance sourceSha/);
  });

  it('rejects duplicate components and inconsistent component identity', () => {
    const [first] = makeComponents();
    const duplicated = makeEnvelope({
      metrics: makeMetrics(HEAD_SHA, { components: [first, first] }),
    });
    expect(() => parse(duplicated)).toThrow(/repeat an id or a root/);

    const renamed = withComponent({ name: 'other-name' });
    expect(() => parse(renamed)).toThrow(/inconsistent; expected id/);

    expect(() => parse(withComponent({ root: '../escape' }))).toThrow('schema validation');
  });

  it('rejects an oversized reason list and unbounded reason text', () => {
    const many = Array.from({ length: 21 }, (_, index) => `reason ${index}`);
    expect(() =>
      parse(withComponent({ tsErrors: { state: 'unavailable', reasons: many } }))
    ).toThrow('schema validation');
    expect(() =>
      parse(withComponent({ tsErrors: { state: 'unavailable', reasons: ['x'.repeat(401)] } }))
    ).toThrow('schema validation');
  });
});

describe('failure modes serialize as explicit states, never as zero or success', () => {
  const cases: Array<[string, Measurement<TestSuiteStats>, DataState]> = [
    ['missing', absentFromProducer('test metrics fragment', 'missing'), 'unavailable'],
    ['canceled producer', absentFromProducer('test metrics fragment', 'canceled'), 'unavailable'],
    ['failed producer', absentFromProducer('test metrics fragment', 'failed'), 'unavailable'],
    ['stale', stale('fragment measured another commit'), 'stale'],
    ['unsupported', unsupported('no lane'), 'unsupported'],
  ];

  it.each(cases)('keeps a %s test result as %s with no value', (_name, tests, state) => {
    const parsed = parse(makeEnvelope({ metrics: makeMetrics(HEAD_SHA, { tests }) }));

    expect(parsed.metrics.tests.state).toBe(state);
    expect(measuredValue(parsed.metrics.tests)).toBeNull();
    expect('value' in parsed.metrics.tests).toBe(false);
    expect(JSON.stringify(parsed.metrics.tests)).not.toMatch(/"passed"|"exitCode"|"success"/);
  });

  it('keeps a partial LoC count as partial, with the reason recorded and the lower bound kept', () => {
    const loc = partial(makeLocStats(60), ['apps/frontend/a.ts: EACCES']);
    const parsed = parse(withComponent({ loc }));

    const cell = parsed.metrics.components[0].loc;
    expect(cell.state).toBe('partial');
    expect(measuredValue(cell)).toBeNull();
    expect(cell).toEqual(loc);
  });
});

describe('serializeQaMetricsEnvelope', () => {
  it('round-trips a valid envelope through the parser', () => {
    const envelope = makeEnvelope();

    expect(parse(JSON.parse(serializeQaMetricsEnvelope(envelope)))).toEqual(envelope);
  });

  it('refuses to emit an envelope the publisher would reject, naming the location', () => {
    const invalid = makeEnvelope({ provenance: { ...makeEnvelope().provenance, runId: 0 } });

    expect(() => serializeQaMetricsEnvelope(invalid)).toThrow(
      /refusing to emit an invalid qa-metrics envelope \(\/provenance\/runId: /
    );
  });
});
