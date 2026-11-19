import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import type { ExternalAccountLimits } from '@mangostudio/shared/external-agents';

import { moduleMockerFor } from '../../../support/mocks/module-mocks';

const mockModule = moduleMockerFor(import.meta.dir);

const refreshAccountUsage = mock(() => Promise.resolve({ limits: undefined }));
const getRuntimeClient = mock(() =>
  Promise.resolve({
    externalAgents: { refreshAccountUsage },
  })
);
const writeExternalAccountLimitsCache = mock(() =>
  Promise.reject(new Error('account limits cache write failed'))
);

/** The registry restores faked modules after every test, so each test installs them again. */
async function installFakes(): Promise<void> {
  await mockModule('../../../../src/services/runtime-client', () => ({
    getRuntimeClient,
  }));

  await mockModule(
    '../../../../src/modules/external-agents/infrastructure/external-account-limits-cache',
    () => ({
      writeExternalAccountLimitsCache,
      // eslint-disable-next-line @typescript-eslint/require-await -- The test double preserves its Promise-returning interface contract.
      readExternalAccountLimitsCache: async () => undefined,
    })
  );
}

// Installed before the dynamic import below so the module under test binds the fakes.
await installFakes();

beforeEach(installFakes);

const { cacheExternalAccountLimitsBestEffort, refreshExternalAccountLimits } =
  await import('../../../../src/modules/external-agents/application/external-account-limits');

const LIMITS: ExternalAccountLimits = {
  targetId: 'codex',
  windows: [{ usedPercent: 42 }],
  observedAtMs: 1_000,
};

afterEach(() => {
  getRuntimeClient.mockClear();
  refreshAccountUsage.mockClear();
  writeExternalAccountLimitsCache.mockClear();
});

describe('refreshExternalAccountLimits', () => {
  it('returns unknown when runtime-client acquisition fails', async () => {
    getRuntimeClient.mockImplementationOnce(() => Promise.reject(new Error('runtime down')));

    const result = await refreshExternalAccountLimits({
      userId: 'user-1',
      environmentId: 'local',
      targetId: 'codex',
      vendorAccountFingerprint: null,
    });

    expect(result).toBeUndefined();
    expect(refreshAccountUsage).not.toHaveBeenCalled();
  });

  it('returns unknown when the runtime refresh itself fails', async () => {
    refreshAccountUsage.mockImplementationOnce(() => Promise.reject(new Error('probe failed')));

    const result = await refreshExternalAccountLimits({
      userId: 'user-1',
      environmentId: 'local',
      targetId: 'codex',
      vendorAccountFingerprint: null,
    });

    expect(result).toBeUndefined();
  });
});

describe('cacheExternalAccountLimitsBestEffort', () => {
  it('swallows a cache write rejection without an unhandled rejection', async () => {
    let unhandled: unknown;
    const onUnhandled = (reason: unknown) => {
      unhandled = reason;
    };
    process.on('unhandledRejection', onUnhandled);

    expect(() =>
      cacheExternalAccountLimitsBestEffort(
        {
          userId: 'user-1',
          environmentId: 'local',
          targetId: 'codex',
          vendorAccountFingerprint: null,
        },
        LIMITS,
        { sessionId: 'session-1' }
      )
    ).not.toThrow();

    await Promise.resolve();
    await Promise.resolve();
    process.off('unhandledRejection', onUnhandled);

    expect(writeExternalAccountLimitsCache).toHaveBeenCalled();
    expect(unhandled).toBeUndefined();
  });
});
