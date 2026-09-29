import { describe, expect, it } from 'bun:test';
import Type from 'typebox';
import Value from 'typebox/value';

import {
  absentFromProducer,
  DATA_STATES,
  describeState,
  MAX_REASON_LENGTH,
  MAX_REASONS,
  measured,
  measuredValue,
  measurement,
  needsAttention,
  partial,
  stale,
  unavailable,
  unsupported,
} from './states';

const cell = measurement(Type.Integer({ minimum: 0 }));

describe('measurement constructors', () => {
  it('only measured and partial carry a value', () => {
    expect(measured(0)).toEqual({ state: 'measured', value: 0 });
    expect(partial(3, 'one file unreadable')).toEqual({
      state: 'partial',
      value: 3,
      reasons: ['one file unreadable'],
    });
    for (const noValue of [stale('other commit'), unavailable('crashed'), unsupported('no lane')]) {
      expect('value' in noValue).toBe(false);
    }
  });

  it('accepts one reason or a list, and bounds count and length', () => {
    expect(unavailable(['a', 'b']).state).toBe('unavailable');

    const many = unavailable(Array.from({ length: MAX_REASONS + 5 }, (_, index) => `r${index}`));
    expect('reasons' in many && many.reasons).toHaveLength(MAX_REASONS);

    const long = unavailable('x'.repeat(MAX_REASON_LENGTH + 50));
    expect('reasons' in long && long.reasons[0]).toHaveLength(MAX_REASON_LENGTH);
  });

  it('never records an empty reason', () => {
    expect(unavailable('')).toEqual({ state: 'unavailable', reasons: ['no reason recorded'] });
  });

  it('output of every constructor validates against the measurement schema', () => {
    for (const value of [
      measured(1),
      partial(1, 'x'),
      stale('x'),
      unavailable('x'),
      unsupported('x'),
    ]) {
      expect(Value.Check(cell, value)).toBe(true);
    }
  });

  it('covers every declared data state', () => {
    expect([...(DATA_STATES as readonly string[])].sort()).toEqual(
      ['measured', 'partial', 'stale', 'unavailable', 'unsupported'].sort()
    );
  });
});

describe('absentFromProducer', () => {
  it.each(['missing', 'failed', 'canceled', 'skipped'] as const)(
    'turns a %s producer into unavailable, never a zero or a pass',
    (cause) => {
      const result = absentFromProducer('test metrics fragment', cause);

      expect(result).toEqual({
        state: 'unavailable',
        reasons: [`test metrics fragment not delivered: producer ${cause}`],
      });
      expect(measuredValue(result)).toBeNull();
    }
  );
});

describe('measuredValue', () => {
  it('returns the value only for a fully measured cell, including a legitimate zero', () => {
    expect(measuredValue(measured(0))).toBe(0);
    expect(measuredValue(partial(5, 'lower bound'))).toBeNull();
    expect(measuredValue(stale('old'))).toBeNull();
    expect(measuredValue(unavailable('gone'))).toBeNull();
    expect(measuredValue(unsupported('n/a'))).toBeNull();
    expect(measuredValue(undefined)).toBeNull();
    expect(measuredValue(null)).toBeNull();
  });
});

describe('needsAttention', () => {
  it('flags partial, stale and unavailable, but not measured or unsupported', () => {
    expect(needsAttention(partial(1, 'x'))).toBe(true);
    expect(needsAttention(stale('x'))).toBe(true);
    expect(needsAttention(unavailable('x'))).toBe(true);
    expect(needsAttention(measured(1))).toBe(false);
    expect(needsAttention(unsupported('x'))).toBe(false);
  });
});

describe('describeState', () => {
  it('names the state and joins its reasons', () => {
    expect(describeState(partial(1, ['a', 'b']))).toBe('partial: a; b');
    expect(describeState(measured(1))).toBe('measured');
  });
});
