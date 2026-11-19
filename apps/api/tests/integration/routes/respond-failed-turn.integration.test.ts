/**
 * `POST /api/respond` saves the user message before it calls the provider. A
 * failed call must leave the transcript readable: the user message followed by an
 * assistant error part, the way `/api/respond/stream` records the same failure,
 * while the HTTP answer stays the mapped error.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getDb } from '../../../src/db/database';
import { respondRoutes } from '../../../src/modules/generation/http/respond-routes';
import { errorHandler } from '../../../src/plugins/error-handler';
import { GenerationDeadlineError } from '../../../src/services/providers/core/generation-deadline';
import {
  getProvider,
  registerProvider,
} from '../../../src/services/providers/core/provider-registry';
import type { AIProvider } from '../../../src/services/providers/types';
import { insertTestChat, insertTestConnector, insertTestUser } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const PROVIDER_DETAIL = 'secret-vendor-host text generation';

let restoreAuth: () => void;
let previousProvider: AIProvider | null = null;
let app: ReturnType<typeof createAuthenticatedApiTestApp>['app'];
let chatId: string;
let modelId: string;

function registerRejectingProvider(failure: Error): void {
  registerProvider({
    providerType: 'openai-compatible',
    warmup: () => Promise.resolve(),
    generateText: () => Promise.reject(failure),
    listModels: () => Promise.resolve([]),
    validateApiKey: () => Promise.resolve(),
    resolveApiKey: () => Promise.resolve('test-key'),
  });
}

beforeEach(async () => {
  const user = await insertTestUser();
  const harness = createAuthenticatedApiTestApp(user, errorHandler, respondRoutes);
  app = harness.app;
  restoreAuth = harness.restore;

  const chat = await insertTestChat(user.id);
  chatId = chat.id;
  modelId = `respond-failed-turn-model-${chat.id}`;
  await insertTestConnector(user.id, { enabledModels: [modelId] });
  try {
    previousProvider = getProvider('openai-compatible');
  } catch {
    previousProvider = null;
  }
});

afterEach(() => {
  restoreAuth();
  if (previousProvider) registerProvider(previousProvider);
  previousProvider = null;
});

function postRespond(signal?: AbortSignal): Request {
  return new Request('http://localhost/respond', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, prompt: 'Hello', model: modelId }),
    signal,
  });
}

interface StoredPart {
  readonly type?: string;
  readonly text?: string;
  readonly status?: string;
  readonly reasonCode?: string;
}

async function readTranscript(): Promise<
  Array<{ role: string; text: string; parts: StoredPart[] }>
> {
  const rows = await getDb()
    .selectFrom('messages')
    .select(['role', 'text', 'parts'])
    .where('chatId', '=', chatId)
    .orderBy('timestamp', 'asc')
    .execute();
  return rows.map((row) => ({
    role: row.role,
    text: row.text,
    parts: row.parts ? (JSON.parse(row.parts) as StoredPart[]) : [],
  }));
}

describe('POST /respond when the provider call fails', () => {
  it('answers 504 for a deadline and persists the error part without the provider detail', async () => {
    registerRejectingProvider(new GenerationDeadlineError(PROVIDER_DETAIL, 120_000));

    const response = await app.handle(postRespond());

    expect(
      response.status,
      `expected 504 for a generation deadline | received ${response.status}`
    ).toBe(504);
    const transcript = await readTranscript();
    expect(
      transcript.map((entry) => entry.role),
      'expected the user message followed by an assistant reply | received an orphaned prompt'
    ).toEqual(['user', 'ai']);
    const reply = transcript[1];
    expect(reply?.parts).toContainEqual({
      type: 'error',
      text: 'The model took too long to respond',
    });
    expect(
      JSON.stringify(reply),
      'expected the transcript to hide the provider detail the deadline error carries'
    ).not.toContain(PROVIDER_DETAIL);
  });

  it('answers 500 for another failure and persists its error part', async () => {
    registerRejectingProvider(new Error('vendor exploded'));

    const response = await app.handle(postRespond());

    expect(response.status, `expected 500 | received ${response.status}`).toBe(500);
    const reply = (await readTranscript())[1];
    expect(reply?.parts).toContainEqual({ type: 'error', text: 'vendor exploded' });
  });

  it('records a client disconnect as a client_disconnect interruption', async () => {
    const clientDisconnect = new AbortController();
    registerProvider({
      providerType: 'openai-compatible',
      warmup: () => Promise.resolve(),
      generateText: (request) =>
        new Promise((_resolve, reject) => {
          // The client hangs up once the provider call is in flight.
          queueMicrotask(() => clientDisconnect.abort());
          request.signal?.addEventListener('abort', () => reject(new Error('aborted by client')), {
            once: true,
          });
        }),
      listModels: () => Promise.resolve([]),
      validateApiKey: () => Promise.resolve(),
      resolveApiKey: () => Promise.resolve('test-key'),
    });

    await app.handle(postRespond(clientDisconnect.signal));

    const reply = (await readTranscript())[1];
    expect(reply?.role, 'expected an assistant row after the client hung up').toBe('ai');
    expect(reply?.parts.find((part) => part.type === 'turn_checkpoint')).toMatchObject({
      status: 'interrupted',
      reasonCode: 'client_disconnect',
    });
  });
});
