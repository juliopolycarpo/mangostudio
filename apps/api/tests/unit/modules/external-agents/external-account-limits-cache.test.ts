import { describe, expect, it } from 'bun:test';
import { getDb } from '../../../../src/db/database';
import {
  readExternalAccountLimitsCache,
  writeExternalAccountLimitsCache,
} from '../../../../src/modules/external-agents/infrastructure/external-account-limits-cache';

describe('external account limits cache key', () => {
  it('isolates snapshots across environments and vendor accounts', async () => {
    const db = getDb();
    const base = {
      userId: 'user-a',
      targetId: 'codex' as const,
      limits: {
        targetId: 'codex' as const,
        windows: [{ usedPercent: 10 }],
        observedAtMs: 1_000,
      },
    };

    await writeExternalAccountLimitsCache(
      {
        userId: base.userId,
        environmentId: 'env-work',
        targetId: base.targetId,
        vendorAccountFingerprint: 'account-work',
      },
      { ...base.limits, windows: [{ usedPercent: 10 }] },
      db
    );
    await writeExternalAccountLimitsCache(
      {
        userId: base.userId,
        environmentId: 'env-personal',
        targetId: base.targetId,
        vendorAccountFingerprint: 'account-work',
      },
      { ...base.limits, windows: [{ usedPercent: 55 }] },
      db
    );
    await writeExternalAccountLimitsCache(
      {
        userId: base.userId,
        environmentId: 'env-work',
        targetId: base.targetId,
        vendorAccountFingerprint: 'account-personal',
      },
      { ...base.limits, windows: [{ usedPercent: 90 }] },
      db
    );

    const work = await readExternalAccountLimitsCache(
      {
        userId: base.userId,
        environmentId: 'env-work',
        targetId: base.targetId,
        vendorAccountFingerprint: 'account-work',
      },
      db
    );
    const personalEnv = await readExternalAccountLimitsCache(
      {
        userId: base.userId,
        environmentId: 'env-personal',
        targetId: base.targetId,
        vendorAccountFingerprint: 'account-work',
      },
      db
    );
    const personalAccount = await readExternalAccountLimitsCache(
      {
        userId: base.userId,
        environmentId: 'env-work',
        targetId: base.targetId,
        vendorAccountFingerprint: 'account-personal',
      },
      db
    );

    expect(work?.windows[0]?.usedPercent).toBe(10);
    expect(personalEnv?.windows[0]?.usedPercent).toBe(55);
    expect(personalAccount?.windows[0]?.usedPercent).toBe(90);
  });
});
