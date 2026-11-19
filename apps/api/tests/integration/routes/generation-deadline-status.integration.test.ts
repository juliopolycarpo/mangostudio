/**
 * A vendor that ran out of time is the provider's timeout, not a hub fault.
 * Pins the wire result for the routes that wait on a model: 504, the
 * `ApiErrorResponse` envelope, the existing `PROVIDER_ERROR` code and a message
 * that names neither the provider nor the deadline.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import Value from 'typebox/value';

import { getDb } from '../../../src/db/database';
import { chatRoutes } from '../../../src/modules/chats/http/chat-routes';
import { respondRoutes } from '../../../src/modules/generation/http/respond-routes';
import { errorHandler } from '../../../src/plugins/error-handler';
import {
  GenerationDeadlineError,
  SHORT_TEXT_GENERATION_TIMEOUT_MS,
} from '../../../src/services/providers/core/generation-deadline';
import {
  getProvider,
  registerProvider,
} from '../../../src/services/providers/core/provider-registry';
import type { AIProvider, TextGenerationRequest } from '../../../src/services/providers/types';
import { insertTestChat, insertTestConnector, insertTestUser } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const PROVIDER_DETAIL = 'secret-vendor-host text generation';

let restoreAuth: () => void;
let previousProvider: AIProvider | null = null;
let app: ReturnType<typeof createAuthenticatedApiTestApp>['app'];
let userId: string;
let chatId: string;
let modelId: string;

/** A provider whose every generation ran out of time, whichever entry point the route uses. */
function createDeadlineExpiredProvider(): AIProvider {
  const expired = () => new GenerationDeadlineError(PROVIDER_DETAIL, 120_000);
  return {
    providerType: 'openai-compatible',
    warmup: () => Promise.resolve(),
    generateText: () => Promise.reject(expired()),
    generateTextStream: () => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(expired()) }),
    }),
    listModels: () => Promise.resolve([]),
    validateApiKey: () => Promise.resolve(),
    resolveApiKey: () => Promise.resolve('test-key'),
  };
}

beforeEach(async () => {
  const user = await insertTestUser();
  userId = user.id;
  const harness = createAuthenticatedApiTestApp(user, errorHandler, respondRoutes, chatRoutes);
  app = harness.app;
  restoreAuth = harness.restore;

  const chat = await insertTestChat(userId);
  chatId = chat.id;
  modelId = `deadline-status-model-${chat.id}`;
  await insertTestConnector(userId, { enabledModels: [modelId] });
  try {
    previousProvider = getProvider('openai-compatible');
  } catch {
    previousProvider = null;
  }
  registerProvider(createDeadlineExpiredProvider());
});

afterEach(() => {
  restoreAuth();
  if (previousProvider) registerProvider(previousProvider);
  previousProvider = null;
});

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function expectGatewayTimeout(response: Response): Promise<void> {
  expect(
    response.status,
    `expected 504 for a generation deadline | received ${response.status}`
  ).toBe(504);
  const body: unknown = await response.json();
  expect(Value.Check(ApiErrorResponseSchema, body)).toBe(true);
  expect(body).toEqual({
    error: 'The model took too long to respond',
    code: ERROR_CODES.PROVIDER_ERROR,
  });
}

describe('generation deadline answers 504', () => {
  it('POST /respond', async () => {
    await expectGatewayTimeout(
      await app.handle(post('/respond', { chatId, prompt: 'Hello', model: modelId }))
    );
  });

  it('POST /chats/:id/compact', async () => {
    await insertHistory();
    await expectGatewayTimeout(
      await app.handle(post(`/chats/${chatId}/compact`, { model: modelId }))
    );
  });

  it('POST /chats/:id/summarize-to-new-chat', async () => {
    await insertHistory();
    await expectGatewayTimeout(
      await app.handle(post(`/chats/${chatId}/summarize-to-new-chat`, { model: modelId }))
    );
  });

  it('POST /chats/title-suggestion', async () => {
    await expectGatewayTimeout(
      await app.handle(post('/chats/title-suggestion', { prompt: 'Name this', model: modelId }))
    );
  });
});

describe('title suggestion budget', () => {
  it('asks the provider for the short generation budget', async () => {
    const requests: TextGenerationRequest[] = [];
    registerProvider({
      ...createDeadlineExpiredProvider(),
      generateText: (req) => {
        requests.push(req);
        return Promise.resolve({ text: 'A Title' });
      },
    });

    const response = await app.handle(
      post('/chats/title-suggestion', { prompt: 'Name this', model: modelId })
    );

    expect(response.status).toBe(200);
    expect(
      requests[0]?.timeoutMs,
      'expected the title call to carry the short generation budget'
    ).toBe(SHORT_TEXT_GENERATION_TIMEOUT_MS);
  });
});

async function insertHistory(): Promise<void> {
  await getDb()
    .insertInto('messages')
    .values({
      id: `deadline-status-seed-${chatId}`,
      chatId,
      role: 'user',
      text: 'Where did we leave off?',
      timestamp: Date.now() - 1000,
      isGenerating: 0,
      interactionMode: 'chat',
    })
    .execute();
}
