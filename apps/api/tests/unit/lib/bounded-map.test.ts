import { describe, expect, it } from 'bun:test';
import { setBounded } from '../../../src/lib/bounded-map';

/**
 * The eviction shared by the external command catalog and the account-limits
 * cache. Both key by things a user controls — environments, targets — so the
 * bound is what keeps a long-lived process from growing one entry per
 * combination anyone ever opened.
 */
describe('setBounded', () => {
  it('keeps entries under the bound untouched', () => {
    const entries = new Map<string, number>();
    setBounded(entries, 'a', 1, 3);
    setBounded(entries, 'b', 2, 3);

    expect([...entries]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('evicts the oldest write once the bound is passed', () => {
    const entries = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    setBounded(entries, 'c', 3, 2);

    expect([...entries.keys()]).toEqual(['b', 'c']);
  });

  /**
   * The reason this is not a plain `set`. A Map orders by first insertion, so
   * rewriting `a` in place would leave it the next thing evicted despite being
   * the most recently written — and a catalog refreshed every turn would be
   * the first entry dropped.
   */
  it('treats a rewrite as the newest entry, not the oldest', () => {
    const entries = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    setBounded(entries, 'a', 9, 2);
    setBounded(entries, 'c', 3, 2);

    expect([...entries]).toEqual([
      ['a', 9],
      ['c', 3],
    ]);
  });

  it('evicts as far as it takes when the bound shrinks below the map', () => {
    const entries = new Map<string, number>([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    setBounded(entries, 'd', 4, 2);

    expect([...entries.keys()]).toEqual(['c', 'd']);
  });

  /** A bound of zero keeps nothing, including the write that just happened. */
  it('holds nothing at a bound of zero', () => {
    const entries = new Map<string, number>();
    setBounded(entries, 'a', 1, 0);

    expect(entries.size).toBe(0);
  });
});
