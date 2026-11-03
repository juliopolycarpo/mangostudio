import { afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';

import * as externalStream from '../../../src/modules/external-agents/application/external-turn-stream';
import { type ExternalTurnStreamResult } from '../../../src/modules/external-agents/application/external-turn-stream';
import * as modelResolver from '../../../src/modules/generation/application/resolve-model';
import { NoModelAvailableError } from '../../../src/modules/generation/application/resolve-model';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import { insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import {
  buildRespondStreamRequest,
  mockPassThroughDb,
  mockVerifiedChatOwnership,
  restoreAllMocks,
} from './_respond-stream-helpers';

let streamSpy: ReturnType<typeof spyOn<typeof externalStream, 'streamExternalTurn'>> | undefined;
let modelSpy: ReturnType<typeof spyOn<typeof modelResolver, 'resolveModel'>> | undefined;
let TEST_USER!: UserFixture;

beforeAll(async () => {
  TEST_USER = await insertTestUser();
});

let restoreAuth: (() => void) | null = null;

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await restoreAllMocks();
  streamSpy?.mockRestore();
  streamSpy = undefined;
  modelSpy?.mockRestore();
  modelSpy = undefined;
});

/**
 * Makes MangoStudio's own model resolution fail outright.
 *
 * That is the whole point of the branch order: an external chat has no
 * MangoStudio model to resolve, so if the preflight ran first every external
 * send would answer 503 about a provider the user never chose.
 */
function mockUnresolvableModel(): void {
  modelSpy = spyOn(modelResolver, 'resolveModel').mockImplementation(() => {
    throw new NoModelAvailableError('text');
  });
}

function mockExternalStream(result: ExternalTurnStreamResult): { readonly calls: unknown[] } {
  const calls: unknown[] = [];
  streamSpy = spyOn(externalStream, 'streamExternalTurn').mockImplementation((input) => {
    calls.push(input);
    return Promise.resolve(result);
  });
  return { calls };
}

function mountRoutes() {
  const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
  restoreAuth = restore;
  return app;
}

describe('POST /respond/stream — external runner', () => {
  it('branches before MangoStudio model resolution', async () => {
    await mockVerifiedChatOwnership('/work/repo', { kind: 'external', targetId: 'codex' });
    await mock.module('../../../src/db/database', mockPassThroughDb(TEST_USER.id));
    mockUnresolvableModel();
    const { calls } = mockExternalStream({
      ok: true,
      response: new Response('data: {"type":"done","done":true}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    });

    const response = await mountRoutes().handle(
      buildRespondStreamRequest({ chatId: 'chat-1', prompt: 'Hello' })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type') ?? '').toContain('text/event-stream');
    expect(calls).toHaveLength(1);
  });

  it('forwards the vendor model and effort the composer chose', async () => {
    await mockVerifiedChatOwnership('/work/repo', { kind: 'external', targetId: 'codex' });
    await mock.module('../../../src/db/database', mockPassThroughDb(TEST_USER.id));
    const { calls } = mockExternalStream({ ok: true, response: new Response('') });

    await mountRoutes().handle(
      buildRespondStreamRequest({
        chatId: 'chat-1',
        prompt: 'Hello',
        externalTurn: { model: 'gpt-5.6-sol', effort: 'high' },
      })
    );

    expect(calls[0]).toMatchObject({
      chatId: 'chat-1',
      prompt: 'Hello',
      externalTurn: { model: 'gpt-5.6-sol', effort: 'high' },
    });
  });

  it.each([
    ['conflict', 409],
    ['unsupported', 409],
    ['unavailable', 503],
    ['validation', 400],
  ] as const)('answers a %s preflight failure with %i and no stream', async (kind, status) => {
    await mockVerifiedChatOwnership('/work/repo', { kind: 'external', targetId: 'codex' });
    await mock.module('../../../src/db/database', mockPassThroughDb(TEST_USER.id));
    mockExternalStream({ ok: false, failure: { kind, message: 'refused' } });

    const response = await mountRoutes().handle(
      buildRespondStreamRequest({ chatId: 'chat-1', prompt: 'Hello' })
    );

    expect(response.status).toBe(status);
    expect(response.headers.get('content-type') ?? '').not.toContain('text/event-stream');
    expect(await response.json()).toMatchObject({ error: 'refused' });
  });

  it('leaves a MangoStudio chat on the internal path', async () => {
    await mockVerifiedChatOwnership();
    await mock.module('../../../src/db/database', mockPassThroughDb(TEST_USER.id));
    mockUnresolvableModel();
    const { calls } = mockExternalStream({ ok: true, response: new Response('') });

    const response = await mountRoutes().handle(
      buildRespondStreamRequest({ chatId: 'chat-1', prompt: 'Hello' })
    );

    expect(calls).toHaveLength(0);
    expect(response.status).toBe(503);
  });
});
