import { describe, expect, it } from 'bun:test';

import { measured, partial, presentValue, stale, unavailable } from '../model/states';
import { makeComponents, makeLaneResult, makeLanes, makeMetrics } from '../testing/metrics-fixture';
import { componentMeasurements, laneRows, tallyLanes } from './access';

const API = 'apps/api';

describe('presentValue', () => {
  it('returns the value of measured and partial cells only', () => {
    expect(presentValue(measured(0))).toBe(0);
    expect(presentValue(partial(5, 'lower bound'))).toBe(5);
    expect(presentValue(stale('old'))).toBeNull();
    expect(presentValue(unavailable('gone'))).toBeNull();
    expect(presentValue(null)).toBeNull();
    expect(presentValue(undefined)).toBeNull();
  });
});

describe('laneRows', () => {
  it('lists the registry lanes of each component, in order', () => {
    const rows = laneRows(makeMetrics('h')).map((row) => `${row.component.root}:${row.laneId}`);

    expect(rows).toEqual([
      'apps/frontend:frontend',
      'apps/api:api-unit',
      'apps/api:api-integration',
      'apps/shared:shared',
    ]);
  });

  it('gives a null cell to a registry lane the document lacks', () => {
    const head = makeMetrics('h', {
      components: makeComponents({ [API]: { lanes: makeLanes(API).slice(0, 1) } }),
    });

    const missing = laneRows(head).find((row) => row.laneId === 'api-integration');

    expect(missing?.cell).toBeNull();
  });

  it('keeps a recorded lane the registry does not know', () => {
    const head = makeMetrics('h', {
      components: makeComponents({
        'crates/mango-protocol': {
          lanes: [{ id: 'rust-mango-protocol', tests: measured(makeLaneResult()) }],
        },
      }),
    });

    expect(laneRows(head).map((row) => row.laneId)).toContain('rust-mango-protocol');
  });

  it('is empty without a document', () => {
    expect(laneRows(null)).toEqual([]);
  });
});

describe('tallyLanes', () => {
  it('sums measured lanes and calls the total complete', () => {
    const tally = tallyLanes([
      measured(makeLaneResult({ passed: 10, failed: 1, skipped: 2, todo: 3, recovered: 1 })),
      measured(makeLaneResult({ passed: 5 })),
    ]);

    expect(tally).toEqual({
      passed: 15,
      failed: 1,
      skipped: 2,
      todo: 3,
      recovered: 1,
      complete: true,
      withValue: 2,
    });
  });

  it('keeps a partial lane as a lower bound and never calls the total complete', () => {
    const tally = tallyLanes([
      measured(makeLaneResult({ passed: 10 })),
      partial(makeLaneResult({ passed: 4 }), 'shard lost'),
    ]);

    expect(tally.passed).toBe(14);
    expect(tally.complete).toBe(false);
  });

  it('counts an unavailable or absent lane as nothing and as incomplete', () => {
    const tally = tallyLanes([measured(makeLaneResult({ passed: 10 })), unavailable('x'), null]);

    expect(tally).toMatchObject({ passed: 10, withValue: 1, complete: false });
  });

  it('is never complete over no lanes at all', () => {
    expect(tallyLanes([])).toMatchObject({ passed: 0, withValue: 0, complete: false });
  });
});

describe('componentMeasurements lane cells', () => {
  it('names each recorded lane under its component root', () => {
    const names = componentMeasurements(makeMetrics('h')).map(([name]) => name);

    expect(names).toContain('lanes/apps/api/api-unit');
    expect(names).toContain('lanes/apps/api/api-integration');
  });
});
