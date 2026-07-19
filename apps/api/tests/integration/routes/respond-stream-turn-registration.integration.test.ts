import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { isActiveTurn } from '../../../src/modules/generation/application/active-turn-registry';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import type { PersistTextTurnStartInput } from '../../../src/modules/generation/infrastructure/conversation-persistence';
import * as realConversationPersistenceNs from '../../../src/modules/generation/infrastructure/conversation-persistence';
import { insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import {
  buildRespondStreamRequest,
  createTestStreamDb,
  mockNoopTools,
  mockProviderRegistry,
  mockVerifiedChatOwnership,
  restoreAllMocks,
} from './_respond-stream-helpers';

const realConversationPersistence = { ...realConversationPersistenceNs };

let testUser!: UserFixture;
let restoreAuth: (() => void) | null = null;

beforeAll(async () => {
  testUser = await insertTestUser();
});

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await mock.module(
    '../../../src/modules/generation/infrastructure/conversation-persistence',
    () => realConversationPersistence
  );
  await restoreAllMocks();
});

async function createRegistrationHarness(
  persistTextTurnStart: (input: PersistTextTurnStartInput) => Promise<unknown>
) {
  await mockVerifiedChatOwnership();
  await mockNoopTools();
  await mockProviderRegistry(async function* streamTurn() {
    await Promise.resolve();
    yield { type: 'assistant_text_delta', text: 'done' };
    yield { type: 'turn_completed', providerState: null };
  });
  await mock.module('../../../src/db/database', () => ({
    getDb: () => createTestStreamDb({ userId: testUser.id }),
  }));
  await mock.module(
    '../../../src/modules/generation/infrastructure/conversation-persistence',
    () => ({ ...realConversationPersistence, persistTextTurnStart })
  );

  const { app, restore } = createAuthenticatedApiTestApp(testUser, respondStreamRoutes);
  restoreAuth = restore;
  return app;
}

describe('POST /respond/stream — active turn registration', () => {
  it('registers the assistant turn before persisting its generating row', async () => {
    let assistantMessageId: string | null = null;
    const app = await createRegistrationHarness((input) => {
      assistantMessageId = input.assistantMessageId;
      expect(isActiveTurn(input.assistantMessageId)).toBe(true);
      return Promise.resolve([]);
    });

    const response = await app.handle(
      buildRespondStreamRequest({
        chatId: 'registration-chat',
        prompt: 'Hello',
        model: 'test-model',
      })
    );
    await response.text();

    expect(assistantMessageId).not.toBeNull();
    expect(isActiveTurn(assistantMessageId ?? '')).toBe(false);
  });

  it('unregisters the assistant turn when preparation fails', async () => {
    let assistantMessageId: string | null = null;
    const app = await createRegistrationHarness((input) => {
      assistantMessageId = input.assistantMessageId;
      expect(isActiveTurn(input.assistantMessageId)).toBe(true);
      return Promise.reject(new Error('injected persistence failure'));
    });

    const response = await app.handle(
      buildRespondStreamRequest({ chatId: 'failure-chat', prompt: 'Hello', model: 'test-model' })
    );
    const body = await response.text();

    expect(body).toContain('injected persistence failure');
    expect(assistantMessageId).not.toBeNull();
    expect(isActiveTurn(assistantMessageId ?? '')).toBe(false);
  });
});
