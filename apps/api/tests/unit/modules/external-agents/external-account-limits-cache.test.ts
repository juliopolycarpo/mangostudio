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

  it('isolates snapshots across users and targets', async () => {
    const db = getDb();
    const shared = {
      environmentId: 'env-work',
      vendorAccountFingerprint: 'account-work',
      limits: {
        windows: [{ usedPercent: 10 }],
        observedAtMs: 1_000,
      },
    };

    await writeExternalAccountLimitsCache(
      {
        userId: 'user-a',
        environmentId: shared.environmentId,
        targetId: 'codex',
        vendorAccountFingerprint: shared.vendorAccountFingerprint,
      },
      { targetId: 'codex', ...shared.limits, windows: [{ usedPercent: 11 }] },
      db
    );
    await writeExternalAccountLimitsCache(
      {
        userId: 'user-b',
        environmentId: shared.environmentId,
        targetId: 'codex',
        vendorAccountFingerprint: shared.vendorAccountFingerprint,
      },
      { targetId: 'codex', ...shared.limits, windows: [{ usedPercent: 22 }] },
      db
    );
    await writeExternalAccountLimitsCache(
      {
        userId: 'user-a',
        environmentId: shared.environmentId,
        targetId: 'claude',
        vendorAccountFingerprint: shared.vendorAccountFingerprint,
      },
      { targetId: 'claude', ...shared.limits, windows: [{ usedPercent: 33 }] },
      db
    );

    const userACodex = await readExternalAccountLimitsCache(
      {
        userId: 'user-a',
        environmentId: shared.environmentId,
        targetId: 'codex',
        vendorAccountFingerprint: shared.vendorAccountFingerprint,
      },
      db
    );
    const userBCodex = await readExternalAccountLimitsCache(
      {
        userId: 'user-b',
        environmentId: shared.environmentId,
        targetId: 'codex',
        vendorAccountFingerprint: shared.vendorAccountFingerprint,
      },
      db
    );
    const userAClaude = await readExternalAccountLimitsCache(
      {
        userId: 'user-a',
        environmentId: shared.environmentId,
        targetId: 'claude',
        vendorAccountFingerprint: shared.vendorAccountFingerprint,
      },
      db
    );

    expect(userACodex?.windows[0]?.usedPercent).toBe(11);
    expect(userBCodex?.windows[0]?.usedPercent).toBe(22);
    expect(userAClaude?.windows[0]?.usedPercent).toBe(33);
  });
});
