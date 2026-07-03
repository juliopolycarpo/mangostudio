import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { getConfig } from '../../../src/lib/config';
import { resetChatGptOAuthSessions } from '../../../src/modules/connectors/application/chatgpt-oauth';
import {
  createChatGptTokenService,
  setChatGptTokenServiceForTests,
} from '../../../src/modules/connectors/infrastructure/chatgpt/token-service';
import { settingsRoutes } from '../../../src/routes/settings';
import { resetChatGptUsageStoreForTests } from '../../../src/services/providers/chatgpt/usage';
import { upsertSecretMetadata } from '../../../src/services/secret-store/metadata';
import { type FakeChatGptServer, startFakeChatGptServer } from '../../support/chatgpt/fake-server';
import type { ErrorPayload } from '../../support/connectors';
import { insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import { createMockSecretStore } from '../../support/mocks/mock-secret-store';

interface TestHarness {
  readonly user: UserFixture;
  readonly fakeChatGpt: FakeChatGptServer;
  readonly app: { handle(request: Request): Promise<Response> };
}

let harness!: TestHarness;
let restoreAuth: (() => void) | null = null;
let previousChatGptConfig: { authBaseUrl: string; apiBaseUrl: string } | null = null;

beforeEach(async () => {
  const fakeChatGpt = startFakeChatGptServer();
  const user = await insertTestUser();

  const config = getConfig();
  previousChatGptConfig = { ...config.chatgpt };
  config.chatgpt.authBaseUrl = fakeChatGpt.authBaseUrl;
  config.chatgpt.apiBaseUrl = fakeChatGpt.apiBaseUrl;
  setChatGptTokenServiceForTests(
    createChatGptTokenService({
      secretStore: createMockSecretStore(),
      authBaseUrl: fakeChatGpt.authBaseUrl,
    })
  );

  const { app, restore } = createAuthenticatedApiTestApp(user, settingsRoutes);
  restoreAuth = restore;
  harness = { user, fakeChatGpt, app };
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  setChatGptTokenServiceForTests(null);
  resetChatGptOAuthSessions();
  resetChatGptUsageStoreForTests();
  if (previousChatGptConfig) Object.assign(getConfig().chatgpt, previousChatGptConfig);
  previousChatGptConfig = null;
  harness?.fakeChatGpt.stop();
});

async function connectChatGpt(): Promise<string> {
  const start = await harness.app.handle(
    new Request('http://localhost/settings/connectors/chatgpt/oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'chatgpt-usage' }),
    })
  );
  expect(start.status).toBe(200);
  const payload = (await start.json()) as { sessionId: string; authorizeUrl: string };
  const callback = await fetch(payload.authorizeUrl);
  expect(callback.status).toBe(200);

  const status = await harness.app.handle(
    new Request(`http://localhost/settings/connectors/chatgpt/oauth/${payload.sessionId}/status`)
  );
  const statusPayload = (await status.json()) as { status: string; connectorId?: string };
  expect(statusPayload.status).toBe('completed');
  return statusPayload.connectorId as string;
}

function redeem(connectorId: string, redeemRequestId: string): Promise<Response> {
  return harness.app.handle(
    new Request(`http://localhost/settings/connectors/${connectorId}/usage/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redeemRequestId }),
    })
  );
}

describe('POST /settings/connectors/:id/usage/reset', () => {
  it('redeems a credit, replays idempotently, and reports exhaustion', async () => {
    const connectorId = await connectChatGpt();
    harness.fakeChatGpt.resetCreditsAvailable = 1;

    const first = await redeem(connectorId, 'redeem-1');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ code: 'reset', windowsReset: 1 });

    // A retry with the same idempotency key never spends a second credit.
    const replay = await redeem(connectorId, 'redeem-1');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ code: 'already_redeemed', windowsReset: 0 });

    // A fresh key against an exhausted pool reports no_credit.
    const exhausted = await redeem(connectorId, 'redeem-2');
    expect(exhausted.status).toBe(200);
    expect(await exhausted.json()).toEqual({ code: 'no_credit', windowsReset: 0 });
  });

  it('refreshes the usage snapshot after a redemption', async () => {
    const connectorId = await connectChatGpt();
    harness.fakeChatGpt.resetCreditsAvailable = 1;
    harness.fakeChatGpt.backendRequests.length = 0;

    const response = await redeem(connectorId, 'redeem-refresh');
    expect(response.status).toBe(200);

    const paths = harness.fakeChatGpt.backendRequests.map((request) => request.path);
    expect(paths).toContain('/wham/rate-limit-reset-credits/consume');
    expect(paths).toContain('/wham/usage');
  });

  it('returns 502 for an unrecognized outcome code', async () => {
    const connectorId = await connectChatGpt();
    harness.fakeChatGpt.consumeBodyOverride = { code: 'mystery_outcome', windows_reset: 1 };

    const response = await redeem(connectorId, 'redeem-unknown');
    expect(response.status).toBe(502);
    const payload = (await response.json()) as ErrorPayload;
    expect(payload.code).toBe(ERROR_CODES.PROVIDER_ERROR);
  });

  it('returns 502 when the backend rejects the consume call', async () => {
    const connectorId = await connectChatGpt();
    harness.fakeChatGpt.consumeFailureStatus = 500;

    const response = await redeem(connectorId, 'redeem-broken');
    expect(response.status).toBe(502);
    const payload = (await response.json()) as ErrorPayload;
    expect(payload.code).toBe(ERROR_CODES.PROVIDER_ERROR);
  });

  it('returns 404 for unknown connectors and non-ChatGPT connectors', async () => {
    const unknown = await redeem('no-such-connector', 'redeem-x');
    expect(unknown.status).toBe(404);

    await upsertSecretMetadata({
      id: 'openai-not-chatgpt',
      name: 'openai-not-chatgpt',
      provider: 'openai',
      configured: true,
      source: 'bun-secrets',
      maskedSuffix: '****...1234',
      updatedAt: Date.now(),
      enabledModels: [],
      userId: harness.user.id,
      baseUrl: null,
    });
    const wrongProvider = await redeem('openai-not-chatgpt', 'redeem-y');
    expect(wrongProvider.status).toBe(404);
    const payload = (await wrongProvider.json()) as ErrorPayload;
    expect(payload.code).toBe(ERROR_CODES.NOT_FOUND);
  });
});

describe('GET /settings/connectors/:id/usage/stats', () => {
  function fetchStats(connectorId: string): Promise<Response> {
    return harness.app.handle(
      new Request(`http://localhost/settings/connectors/${connectorId}/usage/stats`)
    );
  }

  it('returns parsed profile stats', async () => {
    const connectorId = await connectChatGpt();
    harness.fakeChatGpt.profilePayload = {
      stats: {
        lifetime_tokens: 5000,
        current_streak_days: 3,
        daily_usage_buckets: [{ start_date: '2026-07-01', tokens: 120 }],
      },
    };

    const response = await fetchStats(connectorId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      stats: {
        lifetimeTokens: 5000,
        currentStreakDays: 3,
        dailyUsage: [{ startDate: '2026-07-01', tokens: 120 }],
      },
    });
  });

  it('degrades to null stats when the backend has none', async () => {
    const connectorId = await connectChatGpt();

    const response = await fetchStats(connectorId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stats: null });
  });

  it('returns 404 for unknown connectors', async () => {
    const response = await fetchStats('no-such-connector');
    expect(response.status).toBe(404);
  });
});
