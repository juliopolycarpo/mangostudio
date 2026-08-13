import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  ChatGptOAuthStatusSchema,
  StartChatGptOAuthResponseSchema,
} from '@mangostudio/shared/connectors';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import Value from 'typebox/value';
import { getDb } from '../../../src/db/database';
import { getConfig } from '../../../src/lib/config';
import {
  getChatGptOAuthStatus,
  resetChatGptOAuthSessions,
  startChatGptOAuth,
} from '../../../src/modules/connectors/application/chatgpt-oauth';
import { CHATGPT_OAUTH_CALLBACK_PORT } from '../../../src/modules/connectors/infrastructure/chatgpt/oauth-constants';
import {
  createChatGptTokenService,
  setChatGptTokenServiceForTests,
} from '../../../src/modules/connectors/infrastructure/chatgpt/token-service';
import { settingsRoutes } from '../../../src/routes/settings';
import { makeTokenEndpointResponse } from '../../support/chatgpt';
import type { ConnectorListPayload, ErrorPayload } from '../../support/connectors';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import { createMockSecretStore } from '../../support/mocks/mock-secret-store';

const TEST_USER = {
  id: 'test-user-chatgpt-oauth',
  name: 'ChatGPT OAuth User',
  email: 'test-chatgpt-oauth@mangostudio.test',
};

const CALLBACK_BASE = `http://127.0.0.1:${CHATGPT_OAUTH_CALLBACK_PORT}`;

/** Behavior toggle for the fake auth server's token endpoint. */
let tokenEndpointBehavior: 'ok' | 'server-error' = 'ok';

let fakeAuthServer: ReturnType<typeof Bun.serve>;
let fakeAuthBaseUrl: string;
let restoreAuth: (() => void) | null = null;

const secretStore = createMockSecretStore();

beforeAll(async () => {
  fakeAuthServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/oauth/token') {
        if (tokenEndpointBehavior === 'server-error') {
          return new Response('boom', { status: 500 });
        }
        return new Response(JSON.stringify(makeTokenEndpointResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    },
  });
  fakeAuthBaseUrl = `http://127.0.0.1:${fakeAuthServer.port}`;

  setChatGptTokenServiceForTests(
    createChatGptTokenService({ secretStore, authBaseUrl: fakeAuthBaseUrl })
  );

  const db = getDb();
  const now = new Date().toISOString();
  await db
    .insertInto('user')
    .values({
      id: TEST_USER.id,
      name: TEST_USER.name,
      email: TEST_USER.email,
      emailVerified: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
});

afterAll(() => {
  setChatGptTokenServiceForTests(null);
  resetChatGptOAuthSessions();
  fakeAuthServer.stop(true);
});

// The shared test environment re-installs a fresh config before every test,
// so the auth base URL override must be re-applied per test (this hook is
// registered after the environment's, so it runs later).
beforeEach(() => {
  getConfig().chatgpt.authBaseUrl = fakeAuthBaseUrl;
  // Connector listing refreshes plan usage best-effort; keep it on the fake
  // server (404s fast) instead of the real backend.
  getConfig().chatgpt.apiBaseUrl = fakeAuthBaseUrl;
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  resetChatGptOAuthSessions();
  tokenEndpointBehavior = 'ok';
});

async function startOAuthSession(
  app: { handle(request: Request): Promise<Response> },
  body: { name: string; connectorId?: string } = { name: 'my-chatgpt' }
) {
  const response = await app.handle(
    new Request('http://localhost/settings/connectors/chatgpt/oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
  expect(response.status).toBe(200);

  const payload = (await response.json()) as {
    sessionId: string;
    authorizeUrl: string;
    expiresAt: number;
  };
  expect(Value.Check(StartChatGptOAuthResponseSchema, payload)).toBe(true);
  return payload;
}

async function fetchStatus(
  app: { handle(request: Request): Promise<Response> },
  sessionId: string
) {
  const response = await app.handle(
    new Request(`http://localhost/settings/connectors/chatgpt/oauth/${sessionId}/status`)
  );
  expect(response.status).toBe(200);
  const payload = (await response.json()) as {
    status: string;
    connectorId?: string;
    error?: string;
  };
  expect(Value.Check(ChatGptOAuthStatusSchema, payload)).toBe(true);
  return payload;
}

describe('chatgpt oauth routes', () => {
  it('completes the full flow: start → callback → connector listed → delete', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const started = await startOAuthSession(app);
    expect(started.authorizeUrl.startsWith(`${fakeAuthBaseUrl}/oauth/authorize`)).toBe(true);
    expect(started.expiresAt).toBeGreaterThan(Date.now());

    const authorizeUrl = new URL(started.authorizeUrl);
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const state = authorizeUrl.searchParams.get('state');
    expect(state).toBeTruthy();

    // Simulate the browser redirect back to the loopback server.
    const callbackResponse = await fetch(
      `${CALLBACK_BASE}/auth/callback?code=fake-auth-code&state=${state}`
    );
    expect(callbackResponse.status).toBe(200);

    const status = await fetchStatus(app, started.sessionId);
    expect(status.status).toBe('completed');
    expect(status.connectorId).toBeTruthy();

    // The connector shows up as a regular chatgpt connector.
    const listResponse = await app.handle(new Request('http://localhost/settings/connectors'));
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as ConnectorListPayload;
    const connector = list.connectors.find((c) => c.id === status.connectorId);
    expect(connector).toMatchObject({
      provider: 'chatgpt',
      source: 'bun-secrets',
      configured: true,
      name: 'my-chatgpt',
      userId: TEST_USER.id,
      accountLabel: '****....com',
      planType: 'plus',
      needsReauth: false,
    });

    // The token bundle was persisted through the secret store.
    expect(
      secretStore.store.get(`mangostudio:chatgpt-api-key:${status.connectorId}`)
    ).toBeDefined();

    // And it can be removed like any other connector.
    const deleteResponse = await app.handle(
      new Request(`http://localhost/settings/connectors/${status.connectorId}`, {
        method: 'DELETE',
      })
    );
    expect(deleteResponse.status).toBe(200);

    const relistResponse = await app.handle(new Request('http://localhost/settings/connectors'));
    const relist = (await relistResponse.json()) as ConnectorListPayload;
    expect(relist.connectors.some((c) => c.id === status.connectorId)).toBe(false);
  });

  it('updates an existing connector in place during re-authentication', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const first = await startOAuthSession(app);
    const firstUrl = new URL(first.authorizeUrl);
    await fetch(
      `${CALLBACK_BASE}/auth/callback?code=fake-auth-code&state=${firstUrl.searchParams.get('state')}`
    );
    const firstStatus = await fetchStatus(app, first.sessionId);
    expect(firstStatus.connectorId).toBeTruthy();
    const connectorId = firstStatus.connectorId as string;

    const modelsResponse = await app.handle(
      new Request(`http://localhost/settings/connectors/${connectorId}/models`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledModels: ['chatgpt-5'] }),
      })
    );
    expect(modelsResponse.status).toBe(200);

    const second = await startOAuthSession(app, { name: 'my-chatgpt', connectorId });
    const secondUrl = new URL(second.authorizeUrl);
    await fetch(
      `${CALLBACK_BASE}/auth/callback?code=second-code&state=${secondUrl.searchParams.get('state')}`
    );
    const secondStatus = await fetchStatus(app, second.sessionId);
    expect(secondStatus.connectorId).toBe(connectorId);

    const listResponse = await app.handle(new Request('http://localhost/settings/connectors'));
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as ConnectorListPayload;
    const matches = list.connectors.filter((c) => c.id === connectorId);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      provider: 'chatgpt',
      enabledModels: ['chatgpt-5'],
      accountLabel: '****....com',
      planType: 'plus',
      needsReauth: false,
    });
  });

  it('marks ChatGPT connectors that require re-authentication', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const started = await startOAuthSession(app);
    const authorizeUrl = new URL(started.authorizeUrl);
    await fetch(
      `${CALLBACK_BASE}/auth/callback?code=fake-auth-code&state=${authorizeUrl.searchParams.get('state')}`
    );
    const status = await fetchStatus(app, started.sessionId);
    expect(status.connectorId).toBeTruthy();

    await getDb()
      .updateTable('secret_metadata')
      .set({ lastValidationError: ERROR_CODES.CHATGPT_REAUTH_REQUIRED })
      .where('id', '=', status.connectorId as string)
      .execute();

    const listResponse = await app.handle(new Request('http://localhost/settings/connectors'));
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as ConnectorListPayload;
    const connector = list.connectors.find((c) => c.id === status.connectorId);
    expect(connector).toMatchObject({
      provider: 'chatgpt',
      needsReauth: true,
      accountLabel: '****....com',
      planType: 'plus',
    });
  });

  it('marks the session failed on a state mismatch', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const started = await startOAuthSession(app);
    await fetch(`${CALLBACK_BASE}/auth/callback?code=fake-auth-code&state=wrong-state`);

    const status = await fetchStatus(app, started.sessionId);
    expect(status.status).toBe('failed');
    expect(status.error).toBeTruthy();
  });

  it('marks the session failed when the token endpoint errors', async () => {
    tokenEndpointBehavior = 'server-error';
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const started = await startOAuthSession(app);
    const authorizeUrl = new URL(started.authorizeUrl);
    await fetch(
      `${CALLBACK_BASE}/auth/callback?code=bad-code&state=${authorizeUrl.searchParams.get('state')}`
    );

    const status = await fetchStatus(app, started.sessionId);
    expect(status.status).toBe('failed');
  });

  it('returns 503 when the loopback port is already bound', async () => {
    const blocker = Bun.serve({
      hostname: '127.0.0.1',
      port: CHATGPT_OAUTH_CALLBACK_PORT,
      fetch: () => new Response('busy'),
    });

    try {
      const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
      restoreAuth = restore;

      const response = await app.handle(
        new Request('http://localhost/settings/connectors/chatgpt/oauth/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'blocked' }),
        })
      );

      expect(response.status).toBe(503);
      const payload = (await response.json()) as ErrorPayload;
      expect(payload.code).toBe(ERROR_CODES.PROVIDER_ERROR);
      expect(payload.error).toContain('1455');
    } finally {
      blocker.stop(true);
    }
  });

  it('cancelling a session releases the loopback port for the next one', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const started = await startOAuthSession(app);
    const cancelResponse = await app.handle(
      new Request(
        `http://localhost/settings/connectors/chatgpt/oauth/${started.sessionId}/cancel`,
        {
          method: 'POST',
        }
      )
    );
    expect(cancelResponse.status).toBe(200);
    expect(await cancelResponse.json()).toEqual({ success: true });

    // Cancelled session no longer exists.
    const statusResponse = await app.handle(
      new Request(`http://localhost/settings/connectors/chatgpt/oauth/${started.sessionId}/status`)
    );
    expect(statusResponse.status).toBe(404);

    // The port is free again for a new session.
    await startOAuthSession(app);
  });

  it('returns 404 for an unknown session id', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/settings/connectors/chatgpt/oauth/unknown-session/status')
    );

    expect(response.status).toBe(404);
    const payload = (await response.json()) as ErrorPayload;
    expect(payload.code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it('reports pending sessions as expired after the TTL', async () => {
    let currentTime = Date.now();
    const started = await startChatGptOAuth(
      TEST_USER.id,
      { name: 'expiring' },
      { now: () => currentTime }
    );

    expect(getChatGptOAuthStatus(TEST_USER.id, started.sessionId).status).toBe('pending');

    currentTime = started.expiresAt + 1;
    const status = getChatGptOAuthStatus(TEST_USER.id, started.sessionId, {
      now: () => currentTime,
    });
    expect(status.status).toBe('expired');
  });
});
