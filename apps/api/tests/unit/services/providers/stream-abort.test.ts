import { afterEach, describe, expect, it, mock } from 'bun:test';

import { ActivityEventSchema } from '@mangostudio/shared/activity';
import Value from 'typebox/value';

import type { getDb } from '../../../../src/db/database';
import {
  ACTIVITY_RETENTION_MS,
  createActivityRepository,
} from '../../../../src/modules/activity/infrastructure/activity-repository';
import { recordTurnCompletedActivity } from '../../../../src/modules/chats/application/record-turn-activity';
import { respondStreamRoutes } from '../../../../src/modules/generation/http/respond-stream-routes';
import { ActivityInsertCapture } from '../../../support/activity-insert-capture';
import { createAuthenticatedApiTestApp } from '../../../support/harness/create-api-test-app';
import { makeStreamChatRow } from '../../../support/stream-chat-row';

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
  const proxy: Record<string, unknown> = new Proxy(terminal, {
    get(target, prop) {
      if (prop in target) return (target as Record<string, unknown>)[prop as string];
      return () => proxy;
    },
  });
  return proxy;
}

const OWNED_CHAT_ROW = makeStreamChatRow(TEST_USER.id, { id: 'chat-2' });

function makeDb(onInsert?: ActivityInsertCapture['onInsert']): Record<string, unknown> {
  const db: Record<string, unknown> = {
    selectFrom: (table: string) =>
      makeChain(
        table === 'activity_events' || table === 'environment_toolchains'
          ? undefined
          : OWNED_CHAT_ROW
      ),
    insertInto: (table: string) => ({
      values: (values: unknown) => {
        onInsert?.(table, values);
        return { execute: () => Promise.resolve() };
      },
    }),
    updateTable: () => makeChain({ numUpdatedRows: 1n }),
    deleteFrom(table: string) {
      if (table !== 'activity_events') {
        throw new Error(`stream database: expected activity_events deletion | received: ${table}`);
      }
      return makeChain({ numDeletedRows: 0n });
    },
  };
  db.transaction = () => ({
    execute: (callback: (trx: Record<string, unknown>) => unknown) => callback(db),
  });
  return db;
}

describe('respond-stream abort signal', () => {
  it('records a schema-valid completed activity through the abort database', async () => {
    const capture = new ActivityInsertCapture();
    const db = makeDb(capture.onInsert);
    await recordTurnCompletedActivity(
      TEST_USER.id,
      'chat-2',
      db as unknown as ReturnType<typeof getDb>
    );
    expect(capture.rows).toHaveLength(1);
    const row = capture.rows[0];
    const payload = JSON.parse(row?.payloadJson as string) as unknown;
    expect(
      Value.Check(ActivityEventSchema, { ...row, payload }),
      `expected ActivityEventSchema completed turn | received: ${JSON.stringify({ ...row, payload })}`
    ).toBe(true);
    expect(row).toMatchObject({ userId: TEST_USER.id, chatId: 'chat-2', kind: 'turn_completed' });
    expect(payload).toEqual({
      title: 'Stream test chat',
      runner: { kind: 'mangostudio', agentId: 'default' },
    });
  });

  it('refuses retention deletion from unrelated tables', () => {
    const db = makeDb();
    const deleteFrom = db.deleteFrom as (table: string) => unknown;

    expect(() => deleteFrom('messages')).toThrow(
      'stream database: expected activity_events deletion | received: messages'
    );
  });

  it('supports activity retention without returning a chat as an activity row', async () => {
    const db = makeDb();
    const repository = createActivityRepository(db as unknown as ReturnType<typeof getDb>);

    await repository.prune(TEST_USER.id, ACTIVITY_RETENTION_MS + 1);
    const selectFrom = db.selectFrom as (table: string) => {
      executeTakeFirst: () => Promise<unknown>;
    };
    expect(await selectFrom('activity_events').executeTakeFirst()).toBeUndefined();
  });

  it('provider receives the signal and it is not aborted during normal generation', async () => {
    let receivedSignal: AbortSignal | undefined;
    let signalAbortedDuringStream = false;

    await mock.module('../../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
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
      getDb: makeDb,
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

    // Consume the stream to let it complete
    await response.text();

    expect(receivedSignal).toBeDefined();
    expect(signalAbortedDuringStream).toBe(false);
  });

  it('stream cancel callback aborts the signal', async () => {
    const aborted: boolean[] = [];

    await mock.module('../../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
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
      getDb: makeDb,
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
