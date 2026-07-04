import { beforeEach, describe, expect, it } from 'bun:test';
import type { ChatGptUsageSnapshot } from '@mangostudio/shared/connectors';
import { getDb } from '../../../../src/db/database';
import {
  listChatGptUsageSamples,
  persistChatGptUsageSamples,
  USAGE_SAMPLE_RETENTION_MS,
} from '../../../../src/services/providers/chatgpt/usage-sample-store';

const ACCOUNT = 'acct-sample-store';
/** Recent base so fixtures survive the retention prune that runs on insert. */
const BASE = Date.now() - 60_000;

function snapshot(overrides: Partial<ChatGptUsageSnapshot> & { capturedAt: number }) {
  return { source: 'endpoint', ...overrides } as ChatGptUsageSnapshot;
}

beforeEach(async () => {
  await getDb().deleteFrom('connector_usage_samples').execute();
});

describe('persistChatGptUsageSamples', () => {
  it('persists each reported window as one sample', async () => {
    await persistChatGptUsageSamples(
      ACCOUNT,
      snapshot({
        capturedAt: BASE,
        primary: { usedPercent: 12, windowMinutes: 300, resetsAt: BASE + 5_000 },
        secondary: { usedPercent: 40 },
      })
    );

    expect(await listChatGptUsageSamples(ACCOUNT, 'primary', 0)).toEqual([
      { usedPercent: 12, windowMinutes: 300, resetsAt: BASE + 5_000, sampledAt: BASE },
    ]);
    expect(await listChatGptUsageSamples(ACCOUNT, 'secondary', 0)).toEqual([
      { usedPercent: 40, sampledAt: BASE },
    ]);
  });

  it('skips a window whose used-percent is unchanged since the last sample', async () => {
    await persistChatGptUsageSamples(
      ACCOUNT,
      snapshot({ capturedAt: BASE, primary: { usedPercent: 12 }, secondary: { usedPercent: 40 } })
    );
    await persistChatGptUsageSamples(
      ACCOUNT,
      snapshot({
        capturedAt: BASE + 1_000,
        primary: { usedPercent: 12 },
        secondary: { usedPercent: 41 },
      })
    );

    expect(await listChatGptUsageSamples(ACCOUNT, 'primary', 0)).toHaveLength(1);
    expect(await listChatGptUsageSamples(ACCOUNT, 'secondary', 0)).toHaveLength(2);
  });

  it('ignores a snapshot older than the newest stored sample', async () => {
    await persistChatGptUsageSamples(
      ACCOUNT,
      snapshot({ capturedAt: BASE + 1_000, primary: { usedPercent: 20 } })
    );
    await persistChatGptUsageSamples(
      ACCOUNT,
      snapshot({ capturedAt: BASE, primary: { usedPercent: 10 } })
    );

    expect(await listChatGptUsageSamples(ACCOUNT, 'primary', 0)).toEqual([
      { usedPercent: 20, sampledAt: BASE + 1_000 },
    ]);
  });

  it('records a drop back to a previous value (window reset)', async () => {
    await persistChatGptUsageSamples(
      ACCOUNT,
      snapshot({ capturedAt: BASE, primary: { usedPercent: 95 } })
    );
    await persistChatGptUsageSamples(
      ACCOUNT,
      snapshot({ capturedAt: BASE + 1_000, primary: { usedPercent: 2 } })
    );

    expect(await listChatGptUsageSamples(ACCOUNT, 'primary', 0)).toEqual([
      { usedPercent: 95, sampledAt: BASE },
      { usedPercent: 2, sampledAt: BASE + 1_000 },
    ]);
  });

  it('prunes samples older than the retention horizon on insert', async () => {
    const ancient = BASE - USAGE_SAMPLE_RETENTION_MS - 60_000;
    await persistChatGptUsageSamples(
      ACCOUNT,
      snapshot({ capturedAt: ancient, primary: { usedPercent: 5 } })
    );
    await persistChatGptUsageSamples(
      ACCOUNT,
      snapshot({ capturedAt: BASE, primary: { usedPercent: 6 } })
    );

    expect(await listChatGptUsageSamples(ACCOUNT, 'primary', 0)).toEqual([
      { usedPercent: 6, sampledAt: BASE },
    ]);
  });
});

describe('listChatGptUsageSamples', () => {
  it('filters by account, window, and since-timestamp', async () => {
    await persistChatGptUsageSamples(
      ACCOUNT,
      snapshot({ capturedAt: BASE, secondary: { usedPercent: 10 } })
    );
    await persistChatGptUsageSamples(
      ACCOUNT,
      snapshot({ capturedAt: BASE + 1_000, secondary: { usedPercent: 20 } })
    );
    await persistChatGptUsageSamples(
      'other-account',
      snapshot({ capturedAt: BASE + 2_000, secondary: { usedPercent: 99 } })
    );

    expect(await listChatGptUsageSamples(ACCOUNT, 'secondary', BASE + 500)).toEqual([
      { usedPercent: 20, sampledAt: BASE + 1_000 },
    ]);
    expect(await listChatGptUsageSamples(ACCOUNT, 'primary', 0)).toEqual([]);
  });
});
