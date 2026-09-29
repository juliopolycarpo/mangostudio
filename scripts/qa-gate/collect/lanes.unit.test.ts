// How per-lane results travel from the Test job's fragment into the envelope's
// components, and what every way of the fragment going missing becomes.

import { describe, expect, it } from 'bun:test';

import type { LaneResult } from '../model/lanes';
import { measured, presentValue, unavailable } from '../model/states';
import { lanesForComponentRoot } from '../results/lane-components';
import { BASE_REPOSITORY_FILES, makeFakeRepository } from '../testing/fake-repository';
import { expectState } from '../testing/measurement-assertions';
import { makeCoverageSummary, makeLaneResult, makeMetrics } from '../testing/metrics-fixture';
import { collectComponents } from './components';
import {
  NO_FRAGMENT,
  parseTestMetricsFragment,
  resolveTestMetrics,
  unusableTestMetrics,
  withheldTestMetrics,
} from './fragment';
import { discoverComponents } from './registry';

const SHA = 'a'.repeat(40);

const fragmentWith = (lanes: Record<string, ReturnType<typeof measured<LaneResult>>>) => ({
  sourceSha: SHA,
  tests: makeMetrics(SHA).tests,
  lanes,
  coverage: {},
});

describe('fragment lanes', () => {
  it('accepts a fragment that carries lane results', () => {
    const fragment = fragmentWith({ 'api-unit': measured(makeLaneResult()) });

    expect(parseTestMetricsFragment(JSON.stringify(fragment))).toEqual({ fragment });
  });

  it('names the invalid lane value when the fragment fails validation', () => {
    const bad = fragmentWith({
      'api-unit': measured(makeLaneResult({ shards: { expected: 1, complete: 3 } })),
    });

    const result = parseTestMetricsFragment(JSON.stringify(bad));

    expect('error' in result && result.error).toContain('failed schema validation');
  });

  it('still accepts a fragment from before lanes existed', () => {
    const old = { sourceSha: SHA, tests: makeMetrics(SHA).tests, coverage: {} };

    expect('fragment' in parseTestMetricsFragment(JSON.stringify(old))).toBe(true);
  });
});

describe('resolveTestMetrics deliveredLanes', () => {
  it('hands each lane the result the fragment delivered', () => {
    const inputs = resolveTestMetrics(
      fragmentWith({ 'api-unit': measured(makeLaneResult({ passed: 7 })) }),
      SHA
    );

    expect(presentValue(inputs.deliveredLanes('api-unit'))?.passed).toBe(7);
  });

  it('makes a lane the fragment lacks unavailable, never a fallback or a zero', () => {
    const inputs = resolveTestMetrics(fragmentWith({}), SHA);

    const cell = inputs.deliveredLanes('api-integration');

    expectState(cell, 'unavailable');
    expect('reasons' in cell && cell.reasons[0]).toBe(
      'fragment delivered no result for lane api-integration'
    );
  });

  it('makes a fragment with no lanes field at all unavailable for every lane', () => {
    const old = { sourceSha: SHA, tests: makeMetrics(SHA).tests, coverage: {} };

    expectState(resolveTestMetrics(old, SHA).deliveredLanes('frontend'), 'unavailable');
  });

  it('makes lanes stale when the fragment measured another commit', () => {
    const inputs = resolveTestMetrics(
      fragmentWith({ 'api-unit': measured(makeLaneResult()) }),
      'b'.repeat(40)
    );

    expectState(inputs.deliveredLanes('api-unit'), 'stale');
  });

  it('makes lanes unavailable when the fragment was unusable', () => {
    expectState(unusableTestMetrics('bad json').deliveredLanes('api-unit'), 'unavailable');
  });

  it.each(['canceled', 'failed', 'skipped', 'missing'] as const)(
    'makes lanes unavailable when the Test job %s',
    (cause) => {
      const cell = withheldTestMetrics(cause).deliveredLanes('shared');

      expectState(cell, 'unavailable');
      expect('reasons' in cell && cell.reasons[0]).toContain(`producer ${cause}`);
    }
  );

  it('makes lanes unavailable when there is no fragment flag at all', () => {
    expectState(NO_FRAGMENT.deliveredLanes('root'), 'unavailable');
  });
});

describe('collectComponents lanes', () => {
  const collect = async (
    deliver: (laneId: string) => ReturnType<typeof unavailable<LaneResult>>
  ) => {
    const repo = makeFakeRepository(BASE_REPOSITORY_FILES);
    const specs = await discoverComponents(repo);
    const requested: string[] = [];
    const components = await collectComponents(specs, {
      trackedFiles: repo.trackedFiles,
      readText: repo.readText,
      deliveredCoverage: () => measured(makeCoverageSummary()),
      deliveredLanes: (laneId) => {
        requested.push(laneId);
        return deliver(laneId);
      },
      readCoverage: () => Promise.resolve(makeCoverageSummary()),
      countTsErrors: () => Promise.resolve(0),
    });
    return { components, requested };
  };

  it('gives a component exactly the lanes the registry assigns to its root', async () => {
    const { components } = await collect(() => measured(makeLaneResult()));

    for (const component of components) {
      expect((component.lanes ?? []).map((lane) => lane.id)).toEqual(
        lanesForComponentRoot(component.root).map((lane) => lane.id)
      );
    }
  });

  it('records an empty lane list, not a missing key, for a component with no lane', async () => {
    const { components } = await collect(() => measured(makeLaneResult()));

    const crate = components.find((component) => component.kind === 'crate');
    expect(crate?.lanes).toEqual([]);
  });

  it('carries an unavailable lane through as unavailable', async () => {
    const { components } = await collect(() => unavailable('shard 3 lost'));

    const laned = components.find((component) => (component.lanes ?? []).length > 0);
    expect(laned, 'the fixture repository should own at least one lane').toBeDefined();
    for (const lane of laned?.lanes ?? []) expectState(lane.tests, 'unavailable');
  });

  it('asks the fragment for exactly the lanes of the components that own one', async () => {
    const { requested } = await collect(() => measured(makeLaneResult()));

    // The fixture repository has the api workspace (two lanes) and scripts/ (the root lane).
    expect([...requested].sort()).toEqual(['api-integration', 'api-unit', 'root']);
  });
});
