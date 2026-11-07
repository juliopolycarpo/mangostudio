import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Chat } from '@mangostudio/shared/chat';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { type OperationReceipt, OperationReceiptSchema } from '@mangostudio/shared/operations';
import {
  externalAgentEventToStreamChunk,
  externalTurnCompletedChunk,
} from '@mangostudio/shared/streaming';
import Value from 'typebox/value';

import { getDb } from '../../../src/db/database';
import { chatRoutes } from '../../../src/modules/chats/http/chat-routes';
import { respondRoutes } from '../../../src/modules/generation/http/respond-routes';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import { drainOperationStream } from '../../../src/modules/operations/application/drain-operation-stream';
import {
  claimOperation,
  readOperation,
} from '../../../src/modules/operations/application/product-operation';
import {
  getProvider,
  invalidateProviderRoutingCache,
  registerProvider,
} from '../../../src/services/providers/core/provider-registry';
import type {
  AgentEvent,
  AgentTurnRequest,
  AIProvider,
} from '../../../src/services/providers/types';
import {
  insertTestChat,
  insertTestConnector,
  insertTestUser,
  type UserFixture,
} from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

class ControlledProvider implements AIProvider {
  readonly providerType = 'openai-compatible' as const;
  calls = 0;
  directCalls = 0;
  fail = false;
  release: (() => void) | undefined;
  generateText(): ReturnType<AIProvider['generateText']> {
    this.directCalls++;
    return Promise.resolve({ text: 'Answer' });
  }
  listModels(): ReturnType<AIProvider['listModels']> {
    return Promise.resolve([]);
  }
  validateApiKey() {
    return Promise.resolve();
  }
  resolveApiKey() {
    return Promise.resolve('test-key');
  }
  async *generateAgentTurnStream(_request: AgentTurnRequest): AsyncIterable<AgentEvent> {
    this.calls++;
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    if (this.fail) throw new Error('controlled accepted failure');
    yield { type: 'assistant_text_delta', text: 'Answer' };
    yield { type: 'turn_completed' };
  }
}
let user: UserFixture;
let chatId: string;
let provider: ControlledProvider;
let previous: AIProvider;
let app: ReturnType<typeof createAuthenticatedApiTestApp>['app'];
let restore: () => void;
const db = getDb();
function request(path: string, body?: unknown) {
  return new Request(
    `http://localhost${path}`,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : undefined
  );
}
async function waitFor(check: () => Promise<boolean> | boolean) {
  // Await observable work, never timing-based assertions or retries of production work.
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error('expected condition did not become true');
}
async function receipt(id: string) {
  return (await app.handle(request(`/operations/${id}`))).json() as Promise<OperationReceipt>;
}
async function submit(id: string, prompt = 'Hello') {
  return app.handle(
    request('/respond/stream', { chatId, prompt, model: 'operation-test', operationId: id })
  );
}
beforeEach(async () => {
  user = await insertTestUser();
  chatId = (await insertTestChat(user.id)).id;
  await insertTestConnector(user.id, { enabledModels: ['operation-test'] });
  invalidateProviderRoutingCache(user.id);
  previous = getProvider('openai-compatible');
  provider = new ControlledProvider();
  registerProvider(provider);
  const harness = createAuthenticatedApiTestApp(
    user,
    chatRoutes,
    respondStreamRoutes,
    respondRoutes
  );
  app = harness.app;
  restore = harness.restore;
});
afterEach(async () => {
  provider.release?.();
  await waitFor(
    async () =>
      !(await db
        .selectFrom('product_operations')
        .select('operationId')
        .where('userId', '=', user.id)
        .where('state', '=', 'running')
        .executeTakeFirst())
  );
  restore();
  registerProvider(previous);
  invalidateProviderRoutingCache(user.id);
});

describe('durable authorized product operations over real routes/storage', () => {
  it('recovers the same durable receipt after an actual process restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'product-operation-'));
    const worker = new URL('../../support/fixtures/product-operation-worker.ts', import.meta.url)
      .pathname;
    try {
      const reserve = Bun.spawn(
        [process.execPath, worker, join(directory, 'db.sqlite'), 'reserve'],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      expect(await reserve.exited).toBe(0);
      const recover = Bun.spawn(
        [process.execPath, worker, join(directory, 'db.sqlite'), 'recover'],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      const result = await new Response(recover.stdout).text();
      expect(await recover.exited).toBe(0);
      expect(JSON.parse(result)).toMatchObject({
        receipt: { operationId: 'durable', state: 'unresolved' },
        claimed: false,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('atomically creates one chat for concurrent equal keys, and replays a lost response', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.handle(request('/chats', { title: 'First', operationId: 'create-once' }))
      )
    );
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
    const chats = await Promise.all(responses.map((r) => r.json() as Promise<Chat>));
    expect(new Set(chats.map((c) => c.id)).size).toBe(1);
    const replay = await app.handle(
      request('/chats', { operationId: 'create-once', title: 'First' })
    );
    expect(await replay.json()).toEqual(chats[0]);
    expect(
      (await app.handle(request('/chats', { title: 'Different', operationId: 'create-once' })))
        .status
    ).toBe(409);
    expect(Value.Check(OperationReceiptSchema, await receipt('create-once'))).toBe(true);
  });
  it('admits one turn under concurrency, survives a discarded acknowledgement and does not dedupe text', async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => submit('turn-once')));
    expect(responses.map((r) => r.status)).toEqual(Array(6).fill(200));
    await waitFor(() => provider.calls === 1);
    expect((await receipt('turn-once')).state).toBe('running');
    expect((await submit('turn-once', 'Different')).status).toBe(409);
    provider.release?.();
    await waitFor(async () => (await receipt('turn-once')).state === 'completed');
    const completed = await receipt('turn-once');
    expect(completed.messageId).toBeTruthy();
    expect(await (await submit('turn-once')).json()).toEqual(completed);
    expect(provider.calls).toBe(1);
    await submit('new-operation-same-text');
    await waitFor(() => provider.calls === 2);
    provider.release?.();
  });
  it('records accepted failure and permits an explicit new operation', async () => {
    provider.fail = true;
    await submit('accepted-failure');
    await waitFor(() => provider.calls === 1);
    provider.release?.();
    await waitFor(async () => (await receipt('accepted-failure')).state === 'failed');
    await submit('accepted-failure');
    expect(provider.calls).toBe(1);
    provider.fail = false;
    await submit('explicit-retry');
    await waitFor(() => provider.calls === 2);
    provider.release?.();
  });
  it('isolates identical IDs between users and refuses foreign chat/receipt access', async () => {
    const own = (await (
      await app.handle(request('/chats', { title: 'Private', operationId: 'shared-key' }))
    ).json()) as Chat;
    restore();
    const other = await insertTestUser();
    const harness = createAuthenticatedApiTestApp(
      other,
      chatRoutes,
      respondStreamRoutes,
      respondRoutes
    );
    app = harness.app;
    restore = harness.restore;
    expect((await app.handle(request('/operations/shared-key'))).status).toBe(404);
    const foreign = await app.handle(
      request('/respond/stream', { chatId: own.id, prompt: 'Hello', operationId: 'shared-key' })
    );
    expect(foreign.status).toBe(404);
    const theirs = (await (
      await app.handle(request('/chats', { title: 'Private', operationId: 'shared-key' }))
    ).json()) as Chat;
    expect(theirs.id).not.toBe(own.id);
  });
  it('keeps expired keys closed for both lookup and submission', async () => {
    await app.handle(request('/chats', { title: 'Expired', operationId: 'expired' }));
    await db
      .updateTable('product_operations')
      .set({ expiresAt: Date.now() - 1 })
      .where('userId', '=', user.id)
      .where('operationId', '=', 'expired')
      .execute();
    const lookup = await app.handle(request('/operations/expired'));
    expect(lookup.status).toBe(410);
    expect(await lookup.json()).toMatchObject({ code: ERROR_CODES.OPERATION_EXPIRED });
    const replay = await app.handle(
      request('/chats', { title: 'Expired', operationId: 'expired' })
    );
    expect(replay.status).toBe(410);
    expect(await replay.json()).toMatchObject({ code: ERROR_CODES.OPERATION_EXPIRED });
    expect(
      (
        await db
          .selectFrom('product_operations')
          .select('result')
          .where('userId', '=', user.id)
          .where('operationId', '=', 'expired')
          .executeTakeFirst()
      )?.result
    ).toBeNull();
  });
  it('returns not found for an expired receipt whose chat was deleted', async () => {
    await claimOperation(db, user.id, 'deleted-chat', 'submit-turn', { prompt: 'Hello' }, chatId);
    await db
      .updateTable('product_operations')
      .set({ expiresAt: Date.now() - 1 })
      .where('userId', '=', user.id)
      .where('operationId', '=', 'deleted-chat')
      .execute();
    const deleted = await app.handle(
      new Request(`http://localhost/chats/${chatId}`, { method: 'DELETE' })
    );
    expect(deleted.status).toBe(200);
    const lookup = await app.handle(request('/operations/deleted-chat'));
    expect(lookup.status).toBe(404);
    expect(await lookup.json()).toMatchObject({ code: ERROR_CODES.NOT_FOUND });
  });
  it('marks predecessor-owned accepted work unresolved, retaining the admission after restart', async () => {
    await claimOperation(db, user.id, 'restart', 'submit-turn', { prompt: 'Hello' }, chatId);
    await db
      .updateTable('product_operations')
      .set({ owner: 'previous-process' })
      .where('userId', '=', user.id)
      .where('operationId', '=', 'restart')
      .execute();
    expect((await receipt('restart')).state).toBe('unresolved');
    expect(
      (await claimOperation(db, user.id, 'restart', 'submit-turn', { prompt: 'Hello' }, chatId))
        .claimed
    ).toBe(false);
    expect(provider.calls).toBe(0);
  });
  it('admits one keyed non-streaming turn and keeps its result addressable', async () => {
    const body = { chatId, prompt: 'Hello', model: 'operation-test', operationId: 'direct-turn' };
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => app.handle(request('/respond', body)))
    );
    expect(responses.map((response) => response.status)).toEqual(Array(4).fill(200));
    await waitFor(async () => (await receipt('direct-turn')).state === 'completed');
    const completed = await receipt('direct-turn');
    expect(provider.directCalls).toBe(1);
    expect(completed.messageId).toBeTruthy();
    expect(await (await app.handle(request('/respond', body))).json()).toEqual(completed);
    const message = await db
      .selectFrom('messages')
      .select('text')
      .where('id', '=', completed.messageId ?? '')
      .executeTakeFirst();
    expect(message?.text).toBe('Answer');
  });
  it.each([
    ['completed', 'completed'],
    ['vendor-error', 'failed'],
    ['cancelled-by-user', 'failed'],
    ['interrupted', 'failed'],
    ['consent-revoked', 'failed'],
    ['limit-exceeded', 'failed'],
    ['runtime-disconnected', 'unresolved'],
    ['hub-restarted', 'unresolved'],
    ['sequence-gap', 'unresolved'],
    ['session-lost', 'unresolved'],
    ['acceptance-unknown', 'unresolved'],
  ] as const)(
    'recovers external terminal %s as %s even when followed by done and partial text',
    async (reason, expected) => {
      const operationId = `external-${reason}`;
      await claimOperation(db, user.id, operationId, 'submit-turn', { prompt: 'Hello' }, chatId);
      const events = [
        { type: 'text', text: 'Partial answer', done: false },
        ...(reason === 'vendor-error'
          ? [
              externalAgentEventToStreamChunk({
                type: 'error',
                error: { code: 'vendor-failed', message: 'Controlled vendor failure' },
              }),
            ]
          : []),
        externalTurnCompletedChunk(reason),
        { type: 'done', done: true, messageId: 'partial-message' },
      ];
      await drainOperationStream(
        new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')),
        db,
        user.id,
        operationId,
        true
      );
      expect((await receipt(operationId)).state).toBe(expected);
    }
  );
  it('does not treat an external error followed by generic done as success', async () => {
    await claimOperation(db, user.id, 'external-error-only', 'submit-turn', {}, chatId);
    const error = externalAgentEventToStreamChunk({
      type: 'error',
      error: { code: 'vendor-failed', message: 'Controlled failure' },
    });
    await drainOperationStream(
      new Response(`data: ${JSON.stringify(error)}\n\ndata: {"type":"done","done":true}\n\n`),
      db,
      user.id,
      'external-error-only',
      true
    );
    expect((await receipt('external-error-only')).state).toBe('failed');
  });
  it('keeps an external done without an authoritative terminal reason unresolved', async () => {
    await claimOperation(db, user.id, 'external-unknown-terminal', 'submit-turn', {}, chatId);
    await drainOperationStream(
      new Response('data: {"type":"done","done":true}\n\n'),
      db,
      user.id,
      'external-unknown-terminal',
      true
    );
    expect((await receipt('external-unknown-terminal')).state).toBe('unresolved');
  });

  it('keeps an ended stream without a terminal success unresolved', async () => {
    await claimOperation(db, user.id, 'empty-stream', 'submit-turn', { prompt: 'Hello' }, chatId);
    await drainOperationStream(
      new Response('data: {"type":"text","text":"Partial"}\n\n'),
      db,
      user.id,
      'empty-stream'
    );
    expect((await receipt('empty-stream')).state).toBe('unresolved');
    expect(
      (
        await claimOperation(
          db,
          user.id,
          'empty-stream',
          'submit-turn',
          { prompt: 'Hello' },
          chatId
        )
      ).claimed
    ).toBe(false);
  });
  it('refuses expired turn IDs without dispatch', async () => {
    await claimOperation(db, user.id, 'expired-turn', 'submit-turn', { prompt: 'Hello' }, chatId);
    await db
      .updateTable('product_operations')
      .set({ expiresAt: Date.now() - 1 })
      .where('userId', '=', user.id)
      .where('operationId', '=', 'expired-turn')
      .execute();
    const streamed = await submit('expired-turn');
    expect(streamed.status).toBe(410);
    expect(await streamed.json()).toMatchObject({ code: ERROR_CODES.OPERATION_EXPIRED });
    const direct = await app.handle(
      request('/respond', {
        chatId,
        prompt: 'Hello',
        model: 'operation-test',
        operationId: 'expired-turn',
      })
    );
    expect(direct.status).toBe(410);
    expect(await direct.json()).toMatchObject({ code: ERROR_CODES.OPERATION_EXPIRED });
    expect(provider.calls).toBe(0);
    expect(provider.directCalls).toBe(0);
  });
  it('leaves preflight refusals retryable and preserves keyless streaming', async () => {
    const refused = await app.handle(
      request('/respond/stream', { chatId, prompt: '', operationId: 'not-accepted' })
    );
    expect(refused.status).toBe(400);
    expect(await readOperation(db, user.id, 'not-accepted')).toBeUndefined();
    const stream = await app.handle(
      request('/respond/stream', { chatId, prompt: 'Hello', model: 'operation-test' })
    );
    expect(stream.headers.get('Content-Type')).toContain('text/event-stream');
    await waitFor(() => provider.calls === 1);
    provider.release?.();
    expect(await stream.text()).toContain('Answer');
  });
});
