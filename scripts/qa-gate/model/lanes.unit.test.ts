import { describe, expect, it } from 'bun:test';
import Value from 'typebox/value';

import { makeComponents, makeLaneResult, makeMetrics } from '../testing/metrics-fixture';
import { LaneEntrySchema, LaneResultSchema } from './lanes';
import { MetricsSchema } from './metrics';
import { measured, unavailable } from './states';

describe('LaneResultSchema', () => {
  it('accepts a fully delivered lane', () => {
    expect(Value.Check(LaneResultSchema, makeLaneResult())).toBe(true);
  });

  it('rejects more complete shards than expected, naming both numbers', () => {
    const lane = makeLaneResult({ shards: { expected: 2, complete: 5 } });

    const errors = [...Value.Errors(LaneResultSchema, lane)].map((error) => error.message);

    expect(Value.Check(LaneResultSchema, lane)).toBe(false);
    expect(errors.join(' ')).toContain('complete=5 expected=2');
  });

  it('rejects a negative or fractional count', () => {
    expect(Value.Check(LaneResultSchema, makeLaneResult({ failed: -1 }))).toBe(false);
    expect(Value.Check(LaneResultSchema, makeLaneResult({ passed: 1.5 }))).toBe(false);
  });

  it('bounds the headline lists', () => {
    const headlines = Array.from({ length: 9 }, () => ({ message: 'x', originatedIn: null }));

    expect(Value.Check(LaneResultSchema, makeLaneResult({ headlines }))).toBe(false);
  });
});

describe('LaneEntrySchema', () => {
  it('accepts a measured and an unavailable lane, and rejects a value on an unavailable one', () => {
    expect(
      Value.Check(LaneEntrySchema, { id: 'api-unit', tests: measured(makeLaneResult()) })
    ).toBe(true);
    expect(Value.Check(LaneEntrySchema, { id: 'api-unit', tests: unavailable('lost') })).toBe(true);
    expect(
      Value.Check(LaneEntrySchema, {
        id: 'api-unit',
        tests: { state: 'unavailable', value: makeLaneResult(), reasons: ['x'] },
      })
    ).toBe(false);
  });

  it('rejects an id outside the lane-id pattern', () => {
    expect(
      Value.Check(LaneEntrySchema, { id: 'Api Unit!', tests: measured(makeLaneResult()) })
    ).toBe(false);
  });
});

describe('MetricsSchema component lanes', () => {
  it('accepts a document whose components carry lanes', () => {
    expect(Value.Check(MetricsSchema, makeMetrics('a'.repeat(40)))).toBe(true);
  });

  it('still accepts a baseline recorded before lanes existed, so old bases stay loadable', () => {
    const old = makeMetrics('a'.repeat(40), {
      components: makeComponents().map(({ lanes: _dropped, ...component }) => component),
    });

    expect(Value.Check(MetricsSchema, old)).toBe(true);
  });

  it('rejects a lane entry with a bad value inside a component', () => {
    const bad = makeMetrics('a'.repeat(40));
    bad.components[0].lanes = [
      { id: 'x', tests: measured(makeLaneResult({ shards: { expected: 1, complete: 2 } })) },
    ];

    expect(Value.Check(MetricsSchema, bad)).toBe(false);
  });
});
