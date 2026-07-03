/**
 * Full-stack streaming coverage for the ChatGPT provider: the real adapter and
 * Responses protocol core run against an ephemeral fake backend (Bun.serve
 * SSE) wired through `chatgpt.api_base_url`. Only the surrounding
 * infrastructure (DB, secrets, tools registry) is mocked.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import { getConfig } from '../../../src/lib/config';
import { setChatGptTokenServiceForTests } from '../../../src/modules/connectors/infrastructure/chatgpt/token-service';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import * as realCatalogNs from '../../../src/services/providers/catalog';
import { chatGptProvider } from '../../../src/services/providers/chatgpt/index';
import * as realMetadataNs from '../../../src/services/secret-store/metadata';
import { makeTokenBundle, TEST_ACCOUNT_ID } from '../../support/chatgpt';
import { insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import {
  buildRespondStreamRequest,
  makeChain,
  mockVerifiedChatOwnership,
  parsePersistedParts,
  parseSseEvents,
  restoreAllMocks,
} from './_respond-stream-helpers';

const realCatalog = { ...realCatalogNs };
const realMetadata = { ...realMetadataNs };

const READ_FILE_TOOL = {
  name: 'read_file',
  description: 'Read a file from the workspace.',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
};

const TOKEN_BUNDLE = makeTokenBundle();

let TEST_USER!: UserFixture;
let restoreAuth: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Fake ChatGPT backend
// ---------------------------------------------------------------------------

interface RecordedBackendRequest {
  headers: Record<string, string | null>;
  body: Record<string, unknown>;
  aborted: boolean;
}

type BackendBehavior = (callIndex: number, request: Request) => Response | Promise<Response>;

let server: ReturnType<typeof Bun.serve>;
let backendRequests: RecordedBackendRequest[] = [];
let backendBehavior: BackendBehavior = () => new Response('unscripted', { status: 500 });

function sseBody(events: Array<Record<string, unknown>>): string {
  return events.map((ev) => `data: ${JSON.stringify(ev)}\n\n`).join('');
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  return new Response(sseBody(events), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

beforeAll(async () => {
  TEST_USER = await insertTestUser();

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const recorded: RecordedBackendRequest = {
        headers: {
          authorization: request.headers.get('authorization'),
          'chatgpt-account-id': request.headers.get('chatgpt-account-id'),
          'openai-beta': request.headers.get('openai-beta'),
          originator: request.headers.get('originator'),
          session_id: request.headers.get('session_id'),
        },
        body: (await request.json().catch(() => ({}))) as Record<string, unknown>,
        aborted: false,
      };
      request.signal.addEventListener('abort', () => {
        recorded.aborted = true;
      });
      backendRequests.push(recorded);
      return backendBehavior(backendRequests.length, request);
    },
  });

  setChatGptTokenServiceForTests({
    ensureFreshTokens: () => Promise.resolve(TOKEN_BUNDLE),
    forceRefreshTokens: () => Promise.resolve(TOKEN_BUNDLE),
    readBundle: () => Promise.resolve(TOKEN_BUNDLE),
    persistBundle: () => Promise.resolve(),
    deleteBundle: () => Promise.resolve(true),
  });
});

afterAll(() => {
  setChatGptTokenServiceForTests(null);
  server.stop(true);
});

// The shared test environment re-installs a fresh config before every test,
// so the API base URL override must be re-applied per test.
beforeEach(() => {
  getConfig().chatgpt.apiBaseUrl = `http://127.0.0.1:${server.port}`;
  backendRequests = [];
  backendBehavior = () => new Response('unscripted', { status: 500 });
  chatGptProvider.invalidateModelCache?.();
});

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await mock.module('../../../src/services/providers/catalog', () => realCatalog);
  await mock.module('../../../src/services/secret-store/metadata', () => realMetadata);
  await restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Route harness around the real chatgpt provider
// ---------------------------------------------------------------------------

function connectorRow(): SecretMetadataRow {
  return {
    id: 'chatgpt-connector-1',
    name: 'chatgpt-test',
    provider: 'chatgpt',
    configured: 1,
    source: 'bun-secrets',
    maskedSuffix: null,
    updatedAt: Date.now(),
    lastValidatedAt: null,
    lastValidationError: null,
    enabledModels: '[]',
    userId: TEST_USER.id,
    baseUrl: null,
  };
}

async function mockChatGptHarness(insertedMessages: Array<Record<string, unknown>>): Promise<void> {
  await mockVerifiedChatOwnership();

  await mock.module('../../../src/services/secret-store/metadata', () => ({
    ...realMetadata,
    listSecretMetadata: () => Promise.resolve([connectorRow()]),
  }));

  await mock.module('../../../src/services/providers/catalog', () => ({
    ...realCatalog,
    getCachedModelMetadata: () => ({
      providerType: 'chatgpt' as const,
      capabilities: {
        text: true,
        image: false,
        streaming: true,
        reasoning: true,
        tools: true,
        statefulContinuation: false,
      },
    }),
  }));

  await mock.module('../../../src/services/providers/core/provider-registry', () => ({
    getProvider: () => chatGptProvider,
    getProviderForModel: () => Promise.resolve(chatGptProvider),
  }));

  await mock.module('../../../src/services/tools', () => ({
    getAllToolDefinitions: () => [READ_FILE_TOOL],
    getToolDefinitionsForAgent: () => [READ_FILE_TOOL],
    executeTool: () => Promise.resolve('# MangoStudio'),
  }));

  await mock.module('../../../src/modules/messages/infrastructure/message-repository', () => ({
    loadHistory: () => Promise.resolve([]),
    loadRichHistory: () => Promise.resolve([]),
    insertMessage: (message: Record<string, unknown>) => {
      insertedMessages.push({ ...message });
      return Promise.resolve();
    },
    updateMessage: () => Promise.resolve(),
    listByChatId: () => Promise.resolve([]),
    verifyMessageOwnership: () => Promise.resolve(true),
    listLegacyGalleryImages: () => Promise.resolve([]),
  }));

  const dbMock: Record<string, unknown> = {
    selectFrom: () => makeChain({ userId: TEST_USER.id, lastProviderState: null }),
    insertInto: (table: string) => ({
      values: (values: Record<string, unknown>) => {
        if (table === 'messages') insertedMessages.push({ ...values });
        return { execute: () => Promise.resolve() };
      },
    }),
    updateTable: () => ({ set: () => makeChain(undefined) }),
    transaction: () => ({
      execute: (callback: (trx: Record<string, unknown>) => Promise<unknown>) => callback(dbMock),
    }),
  };
  await mock.module('../../../src/db/database', () => ({ getDb: () => dbMock }));
}

// ---------------------------------------------------------------------------
// Scripted backend turns
// ---------------------------------------------------------------------------

const TOOL_CALL_TURN = [
  { type: 'response.output_text.delta', delta: 'Let me check. ' },
  {
    type: 'response.output_item.added',
    item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file' },
  },
  {
    type: 'response.function_call_arguments.done',
    item_id: 'fc_1',
    arguments: '{"path":"README.md"}',
  },
  {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      usage: { input_tokens: 42, output_tokens: 9 },
      output: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_1', summary: [] },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"README.md"}',
        },
      ],
    },
  },
];

const FINAL_TEXT_TURN = [
  { type: 'response.output_text.delta', delta: 'The README describes MangoStudio.' },
  {
    type: 'response.completed',
    response: {
      id: 'resp_2',
      usage: { input_tokens: 60, output_tokens: 8 },
      output: [
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The README describes MangoStudio.' }],
        },
      ],
    },
  },
];

describe('POST /respond/stream — chatgpt provider', () => {
  it('runs a full agentic turn: tool call, registry execution, stateless replay, final text', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];
    await mockChatGptHarness(insertedMessages);
    backendBehavior = (callIndex) =>
      callIndex === 1 ? sseResponse(TOOL_CALL_TURN) : sseResponse(FINAL_TEXT_TURN);

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({
        chatId: 'chatgpt-chat',
        prompt: 'What does the README say?',
        model: 'gpt-5.5',
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());

    expect(sseEvents.find((event) => event.type === 'tool_call_started')).toMatchObject({
      callId: 'call_1',
      name: 'read_file',
    });
    expect(sseEvents.find((event) => event.type === 'tool_call_completed')).toMatchObject({
      callId: 'call_1',
      arguments: '{"path":"README.md"}',
    });
    expect(sseEvents.find((event) => event.type === 'tool_result')).toMatchObject({
      callId: 'call_1',
      name: 'read_file',
      result: '# MangoStudio',
      isError: false,
    });
    expect(
      sseEvents.some(
        (event) =>
          event.type === 'text' && String(event.text).includes('The README describes MangoStudio.')
      )
    ).toBe(true);
    expect(sseEvents.find((event) => event.type === 'done')).toBeDefined();

    // Two backend iterations sharing one session, authenticated as the account.
    expect(backendRequests).toHaveLength(2);
    const [first, second] = backendRequests;
    expect(first?.headers.authorization).toBe(`Bearer ${TOKEN_BUNDLE.accessToken}`);
    expect(first?.headers['chatgpt-account-id']).toBe(TEST_ACCOUNT_ID);
    expect(first?.headers['openai-beta']).toBe('responses=experimental');
    expect(first?.headers.originator).toBe('mangostudio');
    expect(first?.headers.session_id).toBeTruthy();
    expect(second?.headers.session_id).toBe(first?.headers.session_id ?? '');

    // Backend contract: stateless, no cursor, no output cap.
    expect(first?.body).toMatchObject({ store: false, stream: true, model: 'gpt-5.5' });
    expect(first?.body.previous_response_id).toBeUndefined();
    expect(first?.body.max_output_tokens).toBeUndefined();
    expect(first?.body.include).toEqual(['reasoning.encrypted_content']);

    // Second iteration replays the turn-local items and feeds the tool output.
    const secondInput = second?.body.input as Array<Record<string, unknown>>;
    expect(secondInput).toContainEqual({
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'enc_1',
      summary: [],
    });
    expect(secondInput).toContainEqual({
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{"path":"README.md"}',
    });
    expect(secondInput.at(-1)).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      // Tool results are JSON-encoded by the registry before hitting the wire.
      output: JSON.stringify('# MangoStudio'),
    });

    const aiMessage = insertedMessages.find((message) => message.role === 'ai');
    expect(aiMessage).toBeDefined();
    const parts = parsePersistedParts(aiMessage?.parts);
    expect(parts).toContainEqual({
      type: 'tool_call',
      toolCallId: 'call_1',
      name: 'read_file',
      args: { path: 'README.md' },
    });
    expect(parts).toContainEqual({
      type: 'tool_result',
      toolCallId: 'call_1',
      content: JSON.stringify('# MangoStudio'),
      isError: false,
    });
  });

  it('aborts the in-flight backend request when the client disconnects mid-stream', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];
    await mockChatGptHarness(insertedMessages);

    let releaseBackend: (() => void) | undefined;
    backendBehavior = (_callIndex, request) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              sseBody([{ type: 'response.output_text.delta', delta: 'Working…' }])
            )
          );
          const finish = () => {
            releaseBackend = undefined;
            try {
              controller.close();
            } catch {
              // already closed by the abort
            }
          };
          releaseBackend = finish;
          request.signal.addEventListener('abort', finish, { once: true });
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({
        chatId: 'chatgpt-chat-abort',
        prompt: 'Long task',
        model: 'gpt-5.5',
      })
    );
    expect(response.status).toBe(200);

    // Read until the first streamed text event, then disconnect the client.
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let received = '';
    while (reader && !received.includes('"type":"text"')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    await reader?.cancel();

    // The abort must reach the fake backend's in-flight request.
    const deadline = Date.now() + 2_000;
    while (!backendRequests[0]?.aborted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    releaseBackend?.();

    expect(backendRequests).toHaveLength(1);
    expect(backendRequests[0]?.aborted).toBe(true);
    expect(received).toContain('Working…');
    expect(received).not.toContain('"type":"done"');
  });

  it('surfaces reauth-required as an SSE error event when the backend keeps rejecting tokens', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];
    await mockChatGptHarness(insertedMessages);
    backendBehavior = () => Response.json({ error: { message: 'token expired' } }, { status: 401 });

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({
        chatId: 'chatgpt-chat-reauth',
        prompt: 'Hello',
        model: 'gpt-5.5',
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());

    const errorEvent = sseEvents.find((event) => event.type === 'error');
    expect(String(errorEvent?.error)).toContain('ChatGPT session expired');
    expect(sseEvents.find((event) => event.type === 'done')).toBeUndefined();

    // Initial attempt plus exactly one refreshed retry.
    expect(backendRequests).toHaveLength(2);
  });
});
