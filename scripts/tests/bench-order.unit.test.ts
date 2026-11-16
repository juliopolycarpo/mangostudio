import { describe, expect, it } from 'bun:test';

import { rotatedOrder } from '../lib/bench-order';

describe('rotatedOrder', () => {
  it('is ABBA for two candidates', () => {
    const candidates = ['base', 'head'];
    expect([0, 1, 2, 3].map((run) => rotatedOrder(candidates, run).join('>'))).toEqual([
      'base>head',
      'head>base',
      'base>head',
      'head>base',
    ]);
  });

  it('rotates three candidates so each one leads once per cycle', () => {
    const candidates = ['a', 'b', 'c'];
    expect([0, 1, 2, 3].map((run) => rotatedOrder(candidates, run).join(''))).toEqual([
      'abc',
      'bca',
      'cab',
      'abc',
    ]);
  });

  it('puts every candidate first equally often over a full cycle', () => {
    for (const count of [2, 3, 4, 5]) {
      const candidates = Array.from({ length: count }, (_, index) => `c${index}`);
      const leaders = Array.from(
        { length: count * 3 },
        (_, run) => rotatedOrder(candidates, run)[0]
      );
      for (const candidate of candidates) {
        expect(leaders.filter((leader) => leader === candidate)).toHaveLength(3);
      }
    }
  });

  it('starts the first measured run with the first candidate whatever the warm-up count', () => {
    const candidates = ['base', 'head'];
    for (const warmup of [0, 1, 2, 3]) {
      // The benchmark loop runs -warmup .. runs - 1 and orders by that index as is.
      const indexes = Array.from({ length: warmup + 4 }, (_, step) => step - warmup);
      const measured = indexes.filter((run) => run >= 0);
      expect(rotatedOrder(candidates, measured[0] as number)[0]).toBe('base');
      expect(measured.map((run) => rotatedOrder(candidates, run)[0])).toEqual([
        'base',
        'head',
        'base',
        'head',
      ]);
    }
  });

  it('accepts a negative warm-up index', () => {
    expect(rotatedOrder(['a', 'b', 'c'], -1)).toEqual(['c', 'a', 'b']);
  });

  it('does not mutate the caller candidates and handles one or none', () => {
    const candidates = ['base', 'head'];
    rotatedOrder(candidates, 1);
    expect(candidates).toEqual(['base', 'head']);
    expect(rotatedOrder(['only'], 1)).toEqual(['only']);
    expect(rotatedOrder([], 1)).toEqual([]);
  });

  it('refuses a run index that is not an integer', () => {
    for (const run of [0.5, Number.NaN]) {
      expect(() => rotatedOrder(['base', 'head'], run)).toThrow(
        `expected an integer run index | received: ${String(run)}`
      );
    }
  });
});
