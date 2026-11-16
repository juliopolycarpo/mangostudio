import { describe, expect, it } from 'bun:test';

import { abbaOrder } from '../lib/bench-order';

describe('abbaOrder', () => {
  it('keeps the order on even runs and reverses it on odd runs', () => {
    const candidates = ['base', 'head'];
    expect([0, 1, 2, 3].map((run) => abbaOrder(candidates, run).join('>'))).toEqual([
      'base>head',
      'head>base',
      'base>head',
      'head>base',
    ]);
  });

  it('puts every candidate first equally often over an even number of runs', () => {
    const candidates = ['a', 'b', 'c'];
    const firsts = Array.from({ length: 10 }, (_, run) => abbaOrder(candidates, run)[0]);
    expect(firsts.filter((first) => first === 'a')).toHaveLength(5);
    expect(firsts.filter((first) => first === 'c')).toHaveLength(5);
  });

  it('does not mutate the caller candidates', () => {
    const candidates = ['base', 'head'];
    abbaOrder(candidates, 1);
    expect(candidates).toEqual(['base', 'head']);
  });

  it('handles one candidate', () => {
    expect(abbaOrder(['only'], 1)).toEqual(['only']);
  });

  it('refuses a run index that is not a non-negative integer', () => {
    for (const run of [-1, 0.5, Number.NaN]) {
      expect(() => abbaOrder(['base', 'head'], run)).toThrow(
        `expected a non-negative integer run index | received: ${String(run)}`
      );
    }
  });
});
