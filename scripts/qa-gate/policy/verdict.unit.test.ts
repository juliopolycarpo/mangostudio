// Truth table for the verdict policy. The invariant under test: missing,
// partial or stale evidence never yields `pass`; a concrete regression yields
// `fail`; and the policy can fail at all (positive controls).

import { describe, expect, it } from 'bun:test';

import type { LaneResult, Measurement, Metrics } from '../collect/types';
import {
  absentFromProducer,
  measured,
  partial,
  stale,
  unavailable,
  unsupported,
} from '../model/states';
import {
  makeComponents,
  makeCoverageSummary,
  makeLaneResult,
  makeLanes,
  makeMetrics,
} from '../testing/metrics-fixture';
import { evaluateVerdict, type VerdictOutcome } from './verdict';

const API = 'apps/api';
const healthyBase = makeMetrics('base-sha');

const withApiLanes = (lanes: ReturnType<typeof makeLanes>): Metrics =>
  makeMetrics('head-sha', { components: makeComponents({ [API]: { lanes } }) });

const suiteStats = (overrides: Partial<{ exitCode: number | null; parseMiss: boolean }> = {}) => ({
  exitCode: 0 as number | null,
  durationSeconds: 240,
  passed: 1_157,
  root: 4,
  frontend: 230,
  api: 770,
  shared: 96,
  ...overrides,
});

const suite = (overrides: Partial<{ exitCode: number | null; parseMiss: boolean }> = {}) =>
  measured(suiteStats(overrides));

interface Row {
  readonly name: string;
  readonly base: Metrics | null;
  readonly head: Metrics | null;
  readonly outcome: VerdictOutcome;
}

const rows: Row[] = [
  {
    name: 'healthy head, healthy base',
    base: healthyBase,
    head: makeMetrics('h'),
    outcome: 'pass',
  },
  { name: 'healthy head, no base at all', base: null, head: makeMetrics('h'), outcome: 'pass' },
  { name: 'no head metrics', base: healthyBase, head: null, outcome: 'incomplete' },
  {
    name: 'a lane with a failed test',
    base: healthyBase,
    head: withApiLanes(makeLanes(API, { 'api-unit': measured(makeLaneResult({ failed: 2 })) })),
    outcome: 'fail',
  },
  {
    name: 'a lane the watchdog killed',
    base: healthyBase,
    head: withApiLanes(
      makeLanes(API, {
        'api-integration': partial(makeLaneResult({ timedOut: 1 }), 'shard 6: timed out'),
      })
    ),
    outcome: 'fail',
  },
  {
    name: 'a lane that lost a shard report',
    base: healthyBase,
    head: withApiLanes(
      makeLanes(API, { 'api-unit': partial(makeLaneResult(), 'shard 3: no api-unit JUnit report') })
    ),
    outcome: 'incomplete',
  },
  {
    name: 'a lane with nothing readable',
    base: healthyBase,
    head: withApiLanes(makeLanes(API, { 'api-unit': unavailable('no reports') })),
    outcome: 'incomplete',
  },
  {
    name: 'a lane whose result is stale',
    base: healthyBase,
    head: withApiLanes(makeLanes(API, { 'api-unit': stale('other commit') })),
    outcome: 'incomplete',
  },
  {
    name: 'a lane the registry expects, absent from the document',
    base: healthyBase,
    head: withApiLanes(makeLanes(API).filter((lane) => lane.id !== 'api-integration')),
    outcome: 'incomplete',
  },
  {
    name: 'a lane marked unsupported although the registry wires it',
    base: healthyBase,
    head: withApiLanes(makeLanes(API, { 'api-unit': unsupported('not wired') })),
    outcome: 'incomplete',
  },
  {
    name: 'a head from before per-lane results existed',
    base: healthyBase,
    head: makeMetrics('h', { components: makeComponents({ [API]: { lanes: undefined } }) }),
    outcome: 'incomplete',
  },
  {
    name: 'a partial suite',
    base: healthyBase,
    head: makeMetrics('h', { tests: partial(suiteStats(), 'api-unit partial') }),
    outcome: 'incomplete',
  },
  {
    name: 'an unavailable suite (canceled producer)',
    base: healthyBase,
    head: makeMetrics('h', { tests: absentFromProducer('test metrics fragment', 'canceled') }),
    outcome: 'incomplete',
  },
  {
    name: 'a suite that could parse no lane results under exit 0',
    base: healthyBase,
    head: makeMetrics('h', { tests: suite({ parseMiss: true }) }),
    outcome: 'incomplete',
  },
  {
    name: 'a suite with no process exit code',
    base: healthyBase,
    head: makeMetrics('h', { tests: suite({ exitCode: null }) }),
    outcome: 'incomplete',
  },
  {
    name: 'a suite that exited non-zero',
    base: healthyBase,
    head: makeMetrics('h', { tests: suite({ exitCode: 1 }) }),
    outcome: 'fail',
  },
  {
    name: 'a partial suite that still shows a failing exit',
    base: healthyBase,
    head: makeMetrics('h', { tests: partial(suiteStats({ exitCode: 1 }), 'shard lost') }),
    outcome: 'fail',
  },
  {
    name: 'a partial base coverage cell',
    base: makeMetrics('b', {
      components: makeComponents({
        [API]: { coverage: partial(makeCoverageSummary(80), 'lane lcov unreadable') },
      }),
    }),
    head: makeMetrics('h'),
    outcome: 'incomplete',
  },
  {
    name: 'a partial base suite',
    base: makeMetrics('b', { tests: partial(suiteStats(), 'shard lost on main') }),
    head: makeMetrics('h'),
    outcome: 'incomplete',
  },
  {
    name: 'a base lane that is unavailable',
    base: makeMetrics('b', {
      components: makeComponents({
        [API]: { lanes: makeLanes(API, { 'api-unit': unavailable('no reports') }) },
      }),
    }),
    head: makeMetrics('h'),
    outcome: 'incomplete',
  },
  {
    name: 'a base recorded before per-lane results existed',
    base: makeMetrics('b', { components: makeComponents({ [API]: { lanes: undefined } }) }),
    head: makeMetrics('h'),
    outcome: 'pass',
  },
  {
    name: 'a regression together with a gap',
    base: healthyBase,
    head: makeMetrics('h', {
      tests: suite({ exitCode: 1 }),
      duplication: unavailable('jscpd crashed'),
    }),
    outcome: 'fail',
  },
];

describe('evaluateVerdict truth table', () => {
  it.each(rows)('$name -> $outcome', ({ base, head, outcome }) => {
    const verdict = evaluateVerdict(base, head);

    expect(
      verdict.outcome,
      `expected ${outcome} | received ${verdict.outcome} (gaps: ${verdict.gaps.join(', ') || 'none'}; regressions: ${verdict.regressions.join(', ') || 'none'}; base gaps: ${verdict.baseGaps.join(', ') || 'none'})`
    ).toBe(outcome);
  });
});

describe('evaluateVerdict positive controls', () => {
  it('fails deliberately bad coverage, proving the coverage guard can fire', () => {
    const head = makeMetrics('h', {
      components: makeComponents({
        'apps/frontend': { coverage: measured(makeCoverageSummary(20)) },
        [API]: { coverage: measured(makeCoverageSummary(20)) },
        'apps/shared': { coverage: measured(makeCoverageSummary(20)) },
      }),
    });

    const verdict = evaluateVerdict(healthyBase, head);

    expect(verdict.outcome).toBe('fail');
    expect(verdict.regressions).toContain('line coverage −60.00pp');
  });

  it('names the failing lane and its count', () => {
    const head = withApiLanes(
      makeLanes(API, { 'api-integration': measured(makeLaneResult({ failed: 1 })) })
    );

    expect(evaluateVerdict(healthyBase, head).regressions).toContain(
      'test lanes failing: `api-integration` 1 failed test'
    );
  });

  it('passes the same document once the bad input is removed', () => {
    expect(evaluateVerdict(healthyBase, makeMetrics('h')).outcome).toBe('pass');
  });
});

describe('evaluateVerdict never passes on a degraded head measurement', () => {
  const degrade = (
    key: 'tests' | 'tooling' | 'duplication' | 'circularDeps' | 'frontendBundle' | 'dependencies',
    state: 'partial' | 'stale' | 'unavailable'
  ): Metrics => {
    const head = makeMetrics('h');
    const cell = head[key];
    if (cell.state !== 'measured') throw new Error(`fixture ${key} is not measured`);
    const degraded =
      state === 'partial'
        ? partial(cell.value, 'lower bound')
        : state === 'stale'
          ? stale('other commit')
          : unavailable('collector failed');
    return { ...head, [key]: degraded } as Metrics;
  };

  const keys = [
    'tests',
    'tooling',
    'duplication',
    'circularDeps',
    'frontendBundle',
    'dependencies',
  ] as const;
  const states = ['partial', 'stale', 'unavailable'] as const;

  it.each(keys.flatMap((key) => states.map((state) => [key, state] as const)))(
    'a %s measurement that is %s',
    (key, state) => {
      const outcome = evaluateVerdict(healthyBase, degrade(key, state)).outcome;

      expect(outcome, `expected not pass | received ${outcome} for ${key} ${state}`).not.toBe(
        'pass'
      );
    }
  );

  it('a degraded lane, whatever the state', () => {
    const cells: Measurement<LaneResult>[] = [
      partial(makeLaneResult(), 'x'),
      stale('x'),
      unavailable('x'),
      unsupported('x'),
    ];
    for (const cell of cells) {
      const outcome = evaluateVerdict(
        healthyBase,
        withApiLanes(makeLanes(API, { 'api-unit': cell }))
      ).outcome;

      expect(
        outcome,
        `expected not pass | received ${outcome} for lane state ${cell.state}`
      ).not.toBe('pass');
    }
  });
});

describe('evaluateVerdict notes', () => {
  it('keeps recovered failures visible without failing the verdict', () => {
    const head = withApiLanes(
      makeLanes(API, { 'api-unit': measured(makeLaneResult({ recovered: 2 })) })
    );

    const verdict = evaluateVerdict(healthyBase, head);

    expect(verdict.outcome).toBe('pass');
    expect(verdict.notes).toEqual(['recovered failures: `api-unit` 2 tests failed before passing']);
  });
});
