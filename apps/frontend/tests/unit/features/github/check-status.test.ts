/**
 * The one word a chip has room for, and the order the three states outrank each
 * other in.
 */

import { describe, expect, it } from 'bun:test';
import { checkChipStatus } from '../../../../src/features/github/lib/check-status';

describe('checkChipStatus', () => {
  it('reports failure ahead of everything else', () => {
    // A red run is worth interrupting for even while other checks still run.
    expect(checkChipStatus({ passed: 3, failed: 1, pending: 5, total: 9 })).toEqual({
      labelKey: 'checksFailing',
      tone: 'error',
    });
  });

  it('reports running ahead of passing', () => {
    expect(checkChipStatus({ passed: 3, failed: 0, pending: 1, total: 4 })).toEqual({
      labelKey: 'checksRunning',
      tone: 'warning',
    });
  });

  it('reports passing only when nothing failed and nothing is left', () => {
    expect(checkChipStatus({ passed: 4, failed: 0, pending: 0, total: 4 })).toEqual({
      labelKey: 'checksPassing',
      tone: 'success',
    });
  });

  it('treats a pull request with no CI and an empty rollup the same', () => {
    const noChecks = { labelKey: 'noChecks', tone: 'neutral' } as const;
    expect(checkChipStatus(null)).toEqual(noChecks);
    expect(checkChipStatus({ passed: 0, failed: 0, pending: 0, total: 0 })).toEqual(noChecks);
  });

  it('still reports passing when skipped checks make the buckets under-sum', () => {
    // `passed + failed + pending < total` is legitimate: skipped, neutral and
    // cancelled checks belong to none of the three buckets.
    expect(checkChipStatus({ passed: 2, failed: 0, pending: 0, total: 5 }).labelKey).toBe(
      'checksPassing'
    );
  });
});
