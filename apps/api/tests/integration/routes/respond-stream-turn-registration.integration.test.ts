import { afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';

import * as database from '../../../src/db/database';
import { isActiveTurn } from '../../../src/modules/generation/application/active-turn-registry';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
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

let testUser!: UserFixture;
let restoreAuth: (() => void) | null = null;
let getDbSpy: ReturnType<typeof spyOn<typeof database, 'getDb'>> | undefined;

beforeAll(async () => {
  testUser = await insertTestUser();
});

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  getDbSpy?.mockRestore();
  getDbSpy = undefined;
  await restoreAllMocks();
});

async function createRegistrationHarness(insertError?: Error) {
  const generatingRows: Array<{ id: string; active: boolean }> = [];

  function captureGeneratingInsert(table: string, values: Record<string, unknown>): void {
    if (table !== 'messages' || values.role !== 'ai' || values.isGenerating !== 1) return;
    if (typeof values.id !== 'string') {
      throw new Error(
        `generating assistant row: expected a string id | received: ${String(values.id)}`
      );
    }
    generatingRows.push({ id: values.id, active: isActiveTurn(values.id) });
    if (insertError) throw insertError;
  }

  await mockVerifiedChatOwnership();
  await mockNoopTools();
  await mockProviderRegistry(async function* streamTurn() {
    await Promise.resolve();
    yield { type: 'assistant_text_delta', text: 'done' };
    yield { type: 'turn_completed', providerState: null };
  });
  const streamDb = createTestStreamDb({
    userId: testUser.id,
    onInsert: captureGeneratingInsert,
  });
  getDbSpy = spyOn(database, 'getDb').mockReturnValue(
    streamDb as unknown as ReturnType<typeof database.getDb>
  );

  const { app, restore } = createAuthenticatedApiTestApp(testUser, respondStreamRoutes);
  restoreAuth = restore;
  return { app, generatingRows };
}

describe('POST /respond/stream — active turn registration', () => {
  it('registers the assistant turn before persisting its generating row', async () => {
    const { app, generatingRows } = await createRegistrationHarness();

    const response = await app.handle(
      buildRespondStreamRequest({
        chatId: 'registration-chat',
        prompt: 'Hello',
        model: 'test-model',
      })
    );
    expect(await response.text()).toContain('"type":"done"');

    expect(generatingRows).toEqual([{ id: expect.any(String), active: true }]);
    expect(generatingRows.map(({ id }) => isActiveTurn(id))).toEqual([false]);
  });

  it('unregisters the assistant turn when preparation fails', async () => {
    const { app, generatingRows } = await createRegistrationHarness(
      new Error('injected persistence failure')
    );

    const response = await app.handle(
      buildRespondStreamRequest({ chatId: 'failure-chat', prompt: 'Hello', model: 'test-model' })
    );
    const body = await response.text();

    expect(body).toContain('injected persistence failure');
    expect(generatingRows).toEqual([{ id: expect.any(String), active: true }]);
    expect(generatingRows.map(({ id }) => isActiveTurn(id))).toEqual([false]);
  });
});
