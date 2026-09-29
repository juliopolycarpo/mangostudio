import { describe, expect, it } from 'bun:test';

import { measured, partial, unavailable, unsupported } from '../model/states';
import { makeComponents, makeLaneResult, makeLanes, makeMetrics } from '../testing/metrics-fixture';
import { laneFailureItem, missingLanes, recoveredFailuresNote } from './lanes';

const API = 'apps/api';

const withLanes = (lanes: ReturnType<typeof makeLanes>) =>
  makeMetrics('h', { components: makeComponents({ [API]: { lanes } }) });

describe('missingLanes', () => {
  it('is empty when every registry lane has an entry', () => {
    expect(missingLanes(makeMetrics('h'))).toEqual([]);
  });

  it('names a lane the registry expects but the document lacks', () => {
    const head = withLanes(makeLanes(API).filter((lane) => lane.id !== 'api-unit'));

    expect(missingLanes(head)).toEqual(['lanes/apps/api/api-unit']);
  });

  it('names every lane of a component recorded without lane data', () => {
    const head = makeMetrics('h', { components: makeComponents({ [API]: { lanes: undefined } }) });

    expect(missingLanes(head)).toEqual([
      'lanes/apps/api/api-unit',
      'lanes/apps/api/api-integration',
    ]);
  });

  it('counts a lane marked unsupported as missing, and a partial one as present', () => {
    const head = withLanes(
      makeLanes(API, {
        'api-unit': unsupported('not wired'),
        'api-integration': partial(makeLaneResult(), 'shard lost'),
      })
    );

    expect(missingLanes(head)).toEqual(['lanes/apps/api/api-unit']);
  });

  it('expects nothing of a component with no lane wired', () => {
    const head = makeMetrics('h');

    expect(head.components.some((component) => component.root === 'crates/mango-protocol')).toBe(
      true
    );
    expect(missingLanes(head)).toEqual([]);
  });
});

describe('laneFailureItem', () => {
  it('is null when no lane failed or timed out', () => {
    expect(laneFailureItem(makeMetrics('h'))).toBeNull();
  });

  it('lists each failing lane with its own count', () => {
    const head = withLanes(
      makeLanes(API, {
        'api-unit': measured(makeLaneResult({ failed: 2 })),
        'api-integration': measured(makeLaneResult({ failed: 1, timedOut: 1 })),
      })
    );

    expect(laneFailureItem(head)).toBe(
      'test lanes failing: `api-unit` 2 failed tests; `api-integration` 1 failed test, timed out in 1 shard'
    );
  });

  it('reads the lower bound of a partial lane, because a failure in it is still real', () => {
    const head = withLanes(
      makeLanes(API, { 'api-unit': partial(makeLaneResult({ failed: 3 }), 'shard 2 lost') })
    );

    expect(laneFailureItem(head)).toContain('`api-unit` 3 failed tests');
  });

  it('ignores an unavailable lane rather than reading a zero out of it', () => {
    const head = withLanes(makeLanes(API, { 'api-unit': unavailable('no reports') }));

    expect(laneFailureItem(head)).toBeNull();
  });
});

describe('recoveredFailuresNote', () => {
  it('is null when nothing recovered', () => {
    expect(recoveredFailuresNote(makeMetrics('h'))).toBeNull();
  });

  it('names the lane and how many tests failed before passing', () => {
    const head = withLanes(
      makeLanes(API, { 'api-unit': measured(makeLaneResult({ recovered: 1 })) })
    );

    expect(recoveredFailuresNote(head)).toBe(
      'recovered failures: `api-unit` 1 test failed before passing'
    );
  });
});
