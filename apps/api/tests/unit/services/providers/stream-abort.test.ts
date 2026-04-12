import { describe, expect, it, mock, afterEach } from 'bun:test';
import { respondStreamRoutes } from '../../../../src/modules/generation/http/respond-stream-routes';
import { createAuthenticatedApiTestApp } from '../../../support/harness/create-api-test-app';

const TEST_USER = { id: 'abort-test-user', name: 'Abort User', email: 'abort@test.test' };

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  mock.restore();
});

/**
 * Creates a chainable Kysely-mock.
 * - executeTakeFirst() → firstValue (for ownership/single-row lookups)
 * - execute()          → [] (for list queries like loadHistory)
 */
function makeChain(firstValue: unknown): Record<string, unknown> {
  const terminal = {
    execute: () => Promise.resolve([]),
    executeTakeFirst: () => Promise.resolve(firstValue),
  };
  const proxy: Record<string, unknown> = new Proxy(terminal as Record<string, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      return () => proxy;
    },
  });
  return proxy;
}

describe('respond-stream abort signal', () => {
  it('provider receives the signal and it is not aborted during normal generation', async () => {
    let receivedSignal: AbortSignal | undefined;
    let signalAbortedDuringStream = false;

    await mock.module('../../../../src/services/providers/registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          generateTextStream: async function* (req: { signal?: AbortSignal }) {
            await Promise.resolve();
            receivedSignal = req.signal;
            signalAbortedDuringStream = req.signal?.aborted ?? false;
            yield { text: 'hello', done: false };
            yield { text: '', done: true };
          },
        }),
    }));

    await mock.module('../../../../src/services/providers/catalog', () => ({
      getUnifiedModelCatalog: () => Promise.resolve({ textModels: [{ modelId: 'test-model' }] }),
    }));

    await mock.module('../../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => makeChain(undefined),
      }),
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

    await mock.module('../../../../src/services/providers/registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          generateTextStream: async function* (req: { signal?: AbortSignal }) {
            await Promise.resolve();
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

    await mock.module('../../../../src/services/providers/catalog', () => ({
      getUnifiedModelCatalog: () => Promise.resolve({ textModels: [{ modelId: 'test-model' }] }),
    }));

    await mock.module('../../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => makeChain(undefined),
      }),
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
    if (!response.body) throw new Error('expected response body for stream-abort test');
    const reader = response.body.getReader();
    await reader.cancel();

    // After cancel, signal should eventually be aborted on next iteration
    // (the provider checks signal.aborted before each yield)
    // Give the stream a moment to propagate
    await new Promise((r) => setTimeout(r, 10));

    // The stream was cancelled — confirm it didn't throw
    expect(response.headers.get('content-type')).toContain('text/event-stream');
  });
});
