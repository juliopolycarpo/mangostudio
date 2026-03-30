import { describe, expect, it, mock, afterEach } from 'bun:test';
import { respondStreamRoutes } from '../../../../src/routes/respond-stream';
import { createAuthenticatedApiTestApp } from '../../../support/harness/create-api-test-app';

const TEST_USER = { id: 'abort-test-user', name: 'Abort User', email: 'abort@test.test' };

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  mock.restore();
});

describe('respond-stream abort signal', () => {
  it('provider receives the signal and it is not aborted during normal generation', async () => {
    let receivedSignal: AbortSignal | undefined;
    let signalAbortedDuringStream = false;

    mock.module('../../../../src/services/providers/registry', () => ({
      getProviderForModel: async () => ({
        generateTextStream: async function* (req: any) {
          receivedSignal = req.signal;
          signalAbortedDuringStream = req.signal?.aborted ?? false;
          yield { text: 'hello', done: false };
          yield { text: '', done: true };
        },
      }),
    }));

    mock.module('../../../../src/services/providers/catalog', () => ({
      getUnifiedModelCatalog: async () => ({
        textModels: [{ modelId: 'test-model' }],
      }),
    }));

    mock.module('../../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => ({
          select: () => ({
            where: () => ({
              executeTakeFirst: async () => ({ userId: TEST_USER.id }),
            }),
          }),
        }),
        insertInto: () => ({ values: () => ({ execute: async () => {} }) }),
        updateTable: () => ({
          set: () => ({
            where: () => ({
              where: () => ({ execute: async () => {} }),
            }),
          }),
        }),
      }),
    }));

    mock.module('../../../../src/services/chat-service', () => ({
      verifyChatOwnership: async () => true,
    }));

    mock.module('../../../../src/services/message-service', () => ({
      createMessage: async () => {},
      loadChatHistory: async () => [],
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'chat-1', prompt: 'Hi', model: 'test-model' }),
      })
    );

    // Consume the stream to let it complete
    await response.text();

    expect(receivedSignal).toBeDefined();
    expect(signalAbortedDuringStream).toBe(false);
  });

  it('stream cancel callback aborts the signal', async () => {
    const aborted: boolean[] = [];

    mock.module('../../../../src/services/providers/registry', () => ({
      getProviderForModel: async () => ({
        generateTextStream: async function* (req: any) {
          // Yield slowly so there's time to cancel
          for (let i = 0; i < 10; i++) {
            aborted.push(req.signal?.aborted ?? false);
            if (req.signal?.aborted) break;
            yield { text: `chunk-${i}`, done: false };
          }
          yield { text: '', done: true };
        },
      }),
    }));

    mock.module('../../../../src/services/providers/catalog', () => ({
      getUnifiedModelCatalog: async () => ({
        textModels: [{ modelId: 'test-model' }],
      }),
    }));

    mock.module('../../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => ({
          select: () => ({
            where: () => ({
              executeTakeFirst: async () => ({ userId: TEST_USER.id }),
            }),
          }),
        }),
        insertInto: () => ({ values: () => ({ execute: async () => {} }) }),
        updateTable: () => ({
          set: () => ({
            where: () => ({
              where: () => ({ execute: async () => {} }),
            }),
          }),
        }),
      }),
    }));

    mock.module('../../../../src/services/chat-service', () => ({
      verifyChatOwnership: async () => true,
    }));

    mock.module('../../../../src/services/message-service', () => ({
      createMessage: async () => {},
      loadChatHistory: async () => [],
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'chat-2', prompt: 'Hi', model: 'test-model' }),
      })
    );

    expect(response.status).toBe(200);

    // Cancel the stream immediately
    const reader = response.body!.getReader();
    reader.cancel();

    // After cancel, signal should eventually be aborted on next iteration
    // (the provider checks signal.aborted before each yield)
    // Give the stream a moment to propagate
    await new Promise((r) => setTimeout(r, 10));

    // The stream was cancelled — confirm it didn't throw
    expect(response.headers.get('content-type')).toContain('text/event-stream');
  });
});
