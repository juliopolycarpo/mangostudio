import { describe, expect, it } from 'bun:test';
import type { ExternalAccountLimits } from '@mangostudio/shared/external-agents';
import { quotaActivityDelta } from '../../../../src/modules/external-agents/domain/quota-activity';

function limits(usedPercent: number | undefined): ExternalAccountLimits {
  return {
    targetId: 'claude',
    windows: usedPercent === undefined ? [] : [{ usedPercent }],
    observedAtMs: 0,
  };
}

describe('quotaActivityDelta', () => {
  it('is undefined on the first snapshot, with no previous reading', () => {
    expect(quotaActivityDelta(undefined, limits(50))).toBeUndefined();
  });

  it('is undefined when neither side has a metered window', () => {
    expect(quotaActivityDelta(limits(undefined), limits(undefined))).toBeUndefined();
  });

  it('is undefined when only the previous side has no metered window', () => {
    expect(quotaActivityDelta(limits(undefined), limits(50))).toBeUndefined();
  });

  it('is undefined when only the next side has no metered window', () => {
    expect(quotaActivityDelta(limits(50), limits(undefined))).toBeUndefined();
  });

  it('is undefined when the move is below the threshold', () => {
    expect(quotaActivityDelta(limits(50), limits(54))).toBeUndefined();
  });

  it('reports a delta at the threshold moving upward', () => {
    expect(quotaActivityDelta(limits(50), limits(55))).toEqual({
      previousUsedPercent: 50,
      usedPercent: 55,
    });
  });

  it('reports a delta above the threshold moving upward', () => {
    expect(quotaActivityDelta(limits(20), limits(90))).toEqual({
      previousUsedPercent: 20,
      usedPercent: 90,
    });
  });

  it('reports a large negative move — a window reset — as a delta', () => {
    expect(quotaActivityDelta(limits(95), limits(0))).toEqual({
      previousUsedPercent: 95,
      usedPercent: 0,
    });
  });
});
