import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { MessagePart } from '@mangostudio/shared';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { getDb } from '../../src/db/database';
import { getConfig } from '../../src/lib/config';
import {
  getChatGptOAuthStatus,
  resetChatGptOAuthSessions,
  startChatGptOAuth,
} from '../../src/modules/connectors/application/chatgpt-oauth';
import {
  chatGptSecretName,
  createChatGptTokenService,
  setChatGptTokenServiceForTests,
} from '../../src/modules/connectors/infrastructure/chatgpt/token-service';
import { respondStreamRoutes } from '../../src/modules/generation/http/respond-stream-routes';
import { settingsRoutes } from '../../src/routes/settings';
import { chatGptProvider } from '../../src/services/providers/chatgpt';
import {
  type FakeChatGptServer,
  startFakeChatGptServer,
  textResponseEvents,
  toolCallResponseEvents,
} from '../support/chatgpt/fake-server';
import type { ConnectorListPayload, ModelCatalogPayload } from '../support/connectors';
import { insertTestChat, insertTestUser, type UserFixture } from '../support/factories';
import { createAuthenticatedApiTestApp } from '../support/harness/create-api-test-app';
import {
  createMockSecretStore,
  type InMemorySecretStore,
} from '../support/mocks/mock-secret-store';

interface TestHarness {
  readonly user: UserFixture;
  readonly fakeChatGpt: FakeChatGptServer;
  readonly secretStore: InMemorySecretStore;
}

let harness!: TestHarness;
let restoreAuth: (() => void) | null = null;
let previousChatGptConfig: { authBaseUrl: string; apiBaseUrl: string } | null = null;

beforeEach(async () => {
  const fakeChatGpt = startFakeChatGptServer();
  const secretStore = createMockSecretStore();
  const user = await insertTestUser();

  const config = getConfig();
  previousChatGptConfig = { ...config.chatgpt };
  config.chatgpt.authBaseUrl = fakeChatGpt.authBaseUrl;
  config.chatgpt.apiBaseUrl = fakeChatGpt.apiBaseUrl;
  setChatGptTokenServiceForTests(
    createChatGptTokenService({
      secretStore,
      authBaseUrl: fakeChatGpt.authBaseUrl,
    })
  );
  chatGptProvider.invalidateModelCache?.();

  harness = { user, fakeChatGpt, secretStore };
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  setChatGptTokenServiceForTests(null);
  resetChatGptOAuthSessions();
  if (previousChatGptConfig) Object.assign(getConfig().chatgpt, previousChatGptConfig);
  previousChatGptConfig = null;
  harness?.fakeChatGpt.stop();
});

describe('ChatGPT connector lifecycle E2E', () => {
  it('signs in, lists models, refreshes before an agentic tool turn, and removes tokens', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(
      harness.user,
      settingsRoutes,
      respondStreamRoutes
    );
    restoreAuth = restore;

    const connectorId = await connectChatGpt(app);
    await assertConnectorListed(app, connectorId, { needsReauth: false });
    await assertModelsListed(app, 'gpt-5.5');
    await enableModel(app, connectorId, 'gpt-5.5');
    expireStoredBundle(connectorId);

    harness.fakeChatGpt.queueResponsesScripts([
      {
        type: 'events',
        events: toolCallResponseEvents({
          callId: 'call_time',
          itemId: 'fc_time',
          name: 'get_current_datetime',
          argumentsJson: '{"timezone":"UTC","locale":"en-US"}',
        }),
      },
      { type: 'events', events: textResponseEvents('It is available in UTC.', 'resp_final') },
    ]);

    const chat = await insertTestChat(harness.user.id);
    const events = await streamChatTurn(app, {
      chatId: chat.id,
      prompt: 'What time is it in UTC?',
      model: 'gpt-5.5',
    });

    expect(events.find((event) => event.type === 'tool_call_started')).toMatchObject({
      callId: 'call_time',
      name: 'get_current_datetime',
    });
    const toolResult = events.find((event) => event.type === 'tool_result');
    expect(toolResult).toMatchObject({
      callId: 'call_time',
      name: 'get_current_datetime',
      isError: false,
    });
    expect((toolResult?.result as Record<string, unknown>)?.timezone).toBe('UTC');
    expect(events.find((event) => event.type === 'done')).toBeDefined();

    expect(harness.fakeChatGpt.countTokenRequests('refresh_token')).toBe(1);
    expect(readStoredBundle(connectorId).refreshToken).toBe('refresh-token-2');

    const aiMessage = await getDb()
      .selectFrom('messages')
      .select(['role', 'parts'])
      .where('chatId', '=', chat.id)
      .where('role', '=', 'ai')
      .executeTakeFirstOrThrow();
    const parts = parseParts(aiMessage.parts);
    expect(parts).toContainEqual({
      type: 'tool_call',
      toolCallId: 'call_time',
      name: 'get_current_datetime',
      args: { timezone: 'UTC', locale: 'en-US' },
    });
    const persistedToolResult = parts.find((part) => part.type === 'tool_result');
    expect(persistedToolResult).toMatchObject({
      type: 'tool_result',
      toolCallId: 'call_time',
      isError: false,
    });
    expect(String((persistedToolResult as { content?: string })?.content)).toContain('"timezone"');

    const deleteResponse = await app.handle(
      new Request(`http://localhost/settings/connectors/${connectorId}`, { method: 'DELETE' })
    );
    expect(deleteResponse.status).toBe(200);
    expect(
      harness.secretStore.store.get(`mangostudio:${chatGptSecretName(connectorId)}`)
    ).toBeUndefined();
  });

  it('marks reauth over SSE and connector status when refresh is rejected', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(
      harness.user,
      settingsRoutes,
      respondStreamRoutes
    );
    restoreAuth = restore;

    const connectorId = await connectChatGpt(app);
    await enableModel(app, connectorId, 'gpt-5.5');
    expireStoredBundle(connectorId);
    harness.fakeChatGpt.queueTokenFailure({
      grantType: 'refresh_token',
      failure: 'invalid-grant',
    });

    const chat = await insertTestChat(harness.user.id);
    const events = await streamChatTurn(app, {
      chatId: chat.id,
      prompt: 'Hello',
      model: 'gpt-5.5',
    });

    const error = events.find((event) => event.type === 'error');
    expect(error).toMatchObject({
      code: ERROR_CODES.CHATGPT_REAUTH_REQUIRED,
      done: true,
    });
    expect(String(error?.error)).toContain('ChatGPT session expired');

    const connector = await assertConnectorListed(app, connectorId, { needsReauth: true });
    expect(connector.lastValidationError).toBe(ERROR_CODES.CHATGPT_REAUTH_REQUIRED);
  });

  it('single-flights concurrent refreshes for one expired connector', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(
      harness.user,
      settingsRoutes,
      respondStreamRoutes
    );
    restoreAuth = restore;

    const connectorId = await connectChatGpt(app);
    await enableModel(app, connectorId, 'gpt-5.5');
    expireStoredBundle(connectorId);
    harness.fakeChatGpt.tokenDelayMs = 100;
    harness.fakeChatGpt.queueResponsesScripts([
      { type: 'events', events: textResponseEvents('first stream', 'resp_first') },
      { type: 'events', events: textResponseEvents('second stream', 'resp_second') },
    ]);

    const firstChat = await insertTestChat(harness.user.id);
    const secondChat = await insertTestChat(harness.user.id);
    const [firstEvents, secondEvents] = await Promise.all([
      streamChatTurn(app, {
        chatId: firstChat.id,
        prompt: 'First',
        model: 'gpt-5.5',
      }),
      streamChatTurn(app, {
        chatId: secondChat.id,
        prompt: 'Second',
        model: 'gpt-5.5',
      }),
    ]);

    expect(firstEvents.find((event) => event.type === 'done')).toBeDefined();
    expect(secondEvents.find((event) => event.type === 'done')).toBeDefined();
    expect(harness.fakeChatGpt.countTokenRequests('refresh_token')).toBe(1);
    expect(harness.fakeChatGpt.backendRequests).toHaveLength(2);
  });

  it('emits an SSE error when the backend stream fails mid-turn', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(
      harness.user,
      settingsRoutes,
      respondStreamRoutes
    );
    restoreAuth = restore;

    const connectorId = await connectChatGpt(app);
    await enableModel(app, connectorId, 'gpt-5.5');
    harness.fakeChatGpt.queueResponsesScript({
      type: 'malformed',
      events: [{ type: 'response.output_text.delta', delta: 'partial' }],
    });

    const chat = await insertTestChat(harness.user.id);
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    let events: Array<Record<string, unknown>> = [];
    try {
      events = await withTimeout(
        streamChatTurn(app, {
          chatId: chat.id,
          prompt: 'Disconnect',
          model: 'gpt-5.5',
        }),
        3000
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(events.some((event) => event.type === 'text' && event.text === 'partial')).toBe(true);
    expect(events.find((event) => event.type === 'error')).toBeDefined();
    expect(events.find((event) => event.type === 'done')).toBeUndefined();
  });

  it('expires a pending loopback session and frees the callback port', async () => {
    let now = Date.now();
    const first = await startChatGptOAuth(
      harness.user.id,
      { name: 'expiring' },
      { now: () => now }
    );
    expect(getChatGptOAuthStatus(harness.user.id, first.sessionId).status).toBe('pending');

    now = first.expiresAt + 1;
    expect(getChatGptOAuthStatus(harness.user.id, first.sessionId, { now: () => now }).status).toBe(
      'expired'
    );

    const second = await startChatGptOAuth(harness.user.id, { name: 'after-expiry' });
    expect(getChatGptOAuthStatus(harness.user.id, second.sessionId).status).toBe('pending');
  });
});

async function connectChatGpt(app: { handle(request: Request): Promise<Response> }) {
  const start = await app.handle(
    new Request('http://localhost/settings/connectors/chatgpt/oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'chatgpt-e2e' }),
    })
  );
  expect(start.status).toBe(200);
  const payload = (await start.json()) as { sessionId: string; authorizeUrl: string };
  const callback = await fetch(payload.authorizeUrl);
  expect(callback.status).toBe(200);

  const status = await app.handle(
    new Request(`http://localhost/settings/connectors/chatgpt/oauth/${payload.sessionId}/status`)
  );
  expect(status.status).toBe(200);
  const statusPayload = (await status.json()) as { status: string; connectorId?: string };
  expect(statusPayload.status).toBe('completed');
  expect(statusPayload.connectorId).toBeTruthy();
  return statusPayload.connectorId as string;
}

async function assertConnectorListed(
  app: { handle(request: Request): Promise<Response> },
  connectorId: string,
  expected: { needsReauth: boolean }
) {
  const response = await app.handle(new Request('http://localhost/settings/connectors'));
  expect(response.status).toBe(200);
  const list = (await response.json()) as ConnectorListPayload;
  const connector = list.connectors.find((item) => item.id === connectorId);
  expect(connector).toMatchObject({
    id: connectorId,
    provider: 'chatgpt',
    source: 'bun-secrets',
    configured: true,
    needsReauth: expected.needsReauth,
  });
  return connector as NonNullable<typeof connector>;
}

async function assertModelsListed(
  app: { handle(request: Request): Promise<Response> },
  modelId: string
): Promise<void> {
  const response = await app.handle(new Request('http://localhost/settings/models'));
  expect(response.status).toBe(200);
  const catalog = (await response.json()) as ModelCatalogPayload;
  expect(
    catalog.allModels.some((model) => model.provider === 'chatgpt' && model.modelId === modelId)
  ).toBe(true);
}

async function enableModel(
  app: { handle(request: Request): Promise<Response> },
  connectorId: string,
  modelId: string
): Promise<void> {
  const response = await app.handle(
    new Request(`http://localhost/settings/connectors/${connectorId}/models`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabledModels: [modelId] }),
    })
  );
  expect(response.status).toBe(200);
}

async function streamChatTurn(
  app: { handle(request: Request): Promise<Response> },
  body: { chatId: string; prompt: string; model: string }
): Promise<Array<Record<string, unknown>>> {
  const response = await app.handle(
    new Request('http://localhost/respond/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
  expect(response.status).toBe(200);
  return parseSseEvents(await response.text());
}

function readStoredBundle(connectorId: string): Record<string, unknown> {
  const raw = harness.secretStore.store.get(`mangostudio:${chatGptSecretName(connectorId)}`);
  expect(raw).toBeDefined();
  return JSON.parse(raw as string) as Record<string, unknown>;
}

function expireStoredBundle(connectorId: string): void {
  const bundle = readStoredBundle(connectorId);
  harness.secretStore.store.set(
    `mangostudio:${chatGptSecretName(connectorId)}`,
    JSON.stringify({ ...bundle, expiresAt: Date.now() - 1 })
  );
}

function parseParts(raw: string | null): MessagePart[] {
  return raw ? (JSON.parse(raw) as MessagePart[]) : [];
}

function parseSseEvents(raw: string): Array<Record<string, unknown>> {
  return raw
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as Record<string, unknown>);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: Timer | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
