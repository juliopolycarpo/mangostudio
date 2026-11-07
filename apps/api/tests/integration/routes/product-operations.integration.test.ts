import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Chat } from '@mangostudio/shared/chat';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { type OperationReceipt, OperationReceiptSchema } from '@mangostudio/shared/operations';
import {
  externalAgentEventToStreamChunk,
  externalTurnCompletedChunk,
} from '@mangostudio/shared/streaming';
import { sql } from 'kysely';
import Value from 'typebox/value';

import { getDb } from '../../../src/db/database';
import { chatRoutes } from '../../../src/modules/chats/http/chat-routes';
import { respondRoutes } from '../../../src/modules/generation/http/respond-routes';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import { turnRecoveryRoutes } from '../../../src/modules/generation/http/turn-recovery-routes';
import { drainOperationStream } from '../../../src/modules/operations/application/drain-operation-stream';
import {
  claimOperation,
  readOperation,
} from '../../../src/modules/operations/application/product-operation';
import { drainProductOperationWork } from '../../../src/modules/operations/application/product-operation-work';
import {
  getProvider,
  invalidateProviderRoutingCache,
  registerProvider,
} from '../../../src/services/providers/core/provider-registry';
import type {
  AgentEvent,
  AgentTurnRequest,
  AIProvider,
  TextGenerationRequest,
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
  directFail = false;
  directGate: Promise<void> | undefined;
  directEnvironment: string | undefined;
  fail = false;
  release: (() => void) | undefined;
  generateText(request: TextGenerationRequest): ReturnType<AIProvider['generateText']> {
    this.directCalls++;
    this.directEnvironment = request.environmentId;
    if (this.directFail) return Promise.reject(new Error('controlled direct turn failure'));
    return (this.directGate ?? Promise.resolve()).then(() => ({ text: 'Answer' }));
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
    respondRoutes,
    turnRecoveryRoutes
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
    const worker = fileURLToPath(
      new URL('../../support/fixtures/product-operation-worker.ts', import.meta.url)
    );
    const database = join(directory, 'db.sqlite');
    async function runWorker(mode: 'reserve' | 'recover'): Promise<string> {
      const child = Bun.spawn([process.execPath, worker, database, mode], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(
        exitCode,
        `receipt ${mode} worker exited with ${exitCode} | stderr: ${stderr.trim()}`
      ).toBe(0);
      return stdout;
    }

    try {
      await runWorker('reserve');
      const result = await runWorker('recover');
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
  it('keeps an external keyed submission on its original runner after a first-run chat edit', async () => {
    await db
      .updateTable('chats')
      .set({ runnerKind: 'external', runnerAgentId: null, runnerTargetId: 'codex' })
      .where('id', '=', chatId)
      .execute();
    await sql`CREATE TRIGGER change_runner_after_claim
      AFTER INSERT ON product_operations WHEN NEW.operationId = 'runner-at-admission'
      BEGIN
        UPDATE chats SET runnerKind = 'mangostudio', runnerAgentId = 'default', runnerTargetId = NULL
        WHERE id = NEW.chatId;
      END`.execute(db);
    try {
      const response = await submit('runner-at-admission');
      if (response.ok) {
        await waitFor(() => provider.calls === 1);
        provider.release?.();
      }
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'Choose a folder for this chat before starting an external agent turn.',
      });
      expect(provider.calls).toBe(0);
    } finally {
      await sql`DROP TRIGGER change_runner_after_claim`.execute(db);
    }
  });
  it.each(['/respond/stream', '/respond'])(
    'refuses to persist a MangoStudio transcript after the first-run chat switches runners via %s',
    async (path) => {
      const operationId = 'mangostudio-runner-at-admission';
      await sql`CREATE TRIGGER switch_to_external_after_claim
        AFTER INSERT ON product_operations WHEN NEW.operationId = 'mangostudio-runner-at-admission'
        BEGIN
          UPDATE chats SET runnerKind = 'external', runnerAgentId = NULL, runnerTargetId = 'codex'
          WHERE id = NEW.chatId;
        END`.execute(db);
      try {
        const response = await app.handle(
          request(path, { chatId, prompt: 'Hello', model: 'operation-test', operationId })
        );
        expect(response.status).toBe(200);
        await waitFor(async () => {
          if (provider.release) provider.release();
          return (await receipt(operationId)).state !== 'running';
        });
        const messages = await db
          .selectFrom('messages')
          .select('role')
          .where('chatId', '=', chatId)
          .execute();
        expect(messages.map(({ role }) => role)).toEqual([]);
        expect(provider.calls + provider.directCalls).toBe(0);
        expect(await receipt(operationId)).toMatchObject({ state: 'failed' });
      } finally {
        await sql`DROP TRIGGER switch_to_external_after_claim`.execute(db);
      }
    }
  );
  it('dispatches a keyed direct turn with the environment bound when its key was claimed', async () => {
    const operationId = 'binding-at-admission';
    await sql`CREATE TRIGGER change_environment_after_claim
      AFTER INSERT ON product_operations WHEN NEW.operationId = 'binding-at-admission'
      BEGIN
        UPDATE chats SET environmentId = 'changed-after-admission' WHERE id = NEW.chatId;
      END`.execute(db);
    try {
      const response = await app.handle(
        request('/respond', { chatId, prompt: 'Hello', model: 'operation-test', operationId })
      );
      expect(response.status).toBe(200);
      await waitFor(() => provider.directCalls === 1);
      expect(provider.directEnvironment).toBe('local');
    } finally {
      await sql`DROP TRIGGER change_environment_after_claim`.execute(db);
    }
  });
  it('drains accepted streaming work when the running receipt write fails', async () => {
    const operationId = 'stream-running-write-fails';
    await sql`CREATE TRIGGER reject_stream_running_write
      BEFORE UPDATE OF state ON product_operations
      WHEN NEW.operationId = 'stream-running-write-fails' AND NEW.state = 'running'
      BEGIN SELECT RAISE(ABORT, 'controlled running receipt write failure'); END`.execute(db);
    try {
      const response = await submit(operationId);
      await waitFor(() => provider.calls === 1);
      provider.release?.();
      await waitFor(async () =>
        Boolean(
          await db
            .selectFrom('messages')
            .select('id')
            .where('chatId', '=', chatId)
            .where('text', '=', 'Answer')
            .executeTakeFirst()
        )
      );
      await waitFor(async () => (await receipt(operationId)).state !== 'accepted');
      expect(await receipt(operationId)).toMatchObject({ state: 'completed' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: 'accepted' });
    } finally {
      provider.release?.();
      await sql`DROP TRIGGER reject_stream_running_write`.execute(db);
    }
  });
  it('allows the same key to retry a direct turn whose running write failed before dispatch', async () => {
    const operationId = 'direct-running-write-fails';
    const body = { chatId, prompt: 'Hello', model: 'operation-test', operationId };
    await sql`CREATE TRIGGER reject_direct_running_write
      BEFORE UPDATE OF state ON product_operations
      WHEN NEW.operationId = 'direct-running-write-fails' AND NEW.state = 'running'
      BEGIN SELECT RAISE(ABORT, 'controlled direct running receipt write failure'); END`.execute(
      db
    );
    try {
      expect((await app.handle(request('/respond', body))).status).toBe(500);
      expect(provider.directCalls).toBe(0);
    } finally {
      await sql`DROP TRIGGER reject_direct_running_write`.execute(db);
    }
    expect((await app.handle(request(`/operations/${operationId}`))).status).toBe(404);
    expect((await app.handle(request('/respond', body))).status).toBe(200);
    await waitFor(async () => (await receipt(operationId)).state === 'completed');
    expect(provider.directCalls).toBe(1);
  });
  it.each(['completed', 'failed'] as const)(
    'recovers a direct turn after its %s receipt write fails',
    async (state) => {
      const operationId = 'direct-terminal-write-fails';
      const body = { chatId, prompt: 'Hello', model: 'operation-test', operationId };
      provider.directFail = state === 'failed';
      await sql`CREATE TEMP TABLE direct_terminal_write_attempts (operationId TEXT)`.execute(db);
      await sql`CREATE TEMP TRIGGER reject_direct_terminal_write
        BEFORE UPDATE OF state ON product_operations
        WHEN NEW.operationId = 'direct-terminal-write-fails' AND NEW.state IN ('completed', 'failed')
        BEGIN
          INSERT INTO direct_terminal_write_attempts VALUES (NEW.operationId);
          SELECT RAISE(FAIL, 'controlled terminal receipt write failure');
        END`.execute(db);
      try {
        expect((await app.handle(request('/respond', body))).status).toBe(200);
        await waitFor(async () => {
          const attempts =
            await sql`SELECT operationId FROM direct_terminal_write_attempts`.execute(db);
          return attempts.rows.length > 0;
        });
      } finally {
        await sql`DROP TRIGGER reject_direct_terminal_write`.execute(db);
        await sql`DROP TABLE direct_terminal_write_attempts`.execute(db);
      }

      const message = await db
        .selectFrom('messages')
        .select('id')
        .where('chatId', '=', chatId)
        .where('text', '=', 'Answer')
        .executeTakeFirst();
      if (state === 'completed') expect(message?.id).toBeString();
      else expect(message).toBeUndefined();
      const expected = { state, messageId: message?.id ?? null };
      expect(await receipt(operationId)).toMatchObject(expected);
      const replay = await app.handle(request('/respond', body));
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject(expected);
      expect(provider.directCalls).toBe(1);
    }
  );
  it.each(['/respond/stream', '/respond'])(
    'keeps the completed receipt when %s cannot update chat recency',
    async (path) => {
      const operationId = 'chat-recency-write-fails';
      await sql`CREATE TRIGGER reject_chat_recency_write
        BEFORE UPDATE OF updatedAt ON chats
        WHEN OLD.id IN (SELECT chatId FROM product_operations WHERE operationId = 'chat-recency-write-fails')
        BEGIN SELECT RAISE(ABORT, 'controlled chat recency write failure'); END`.execute(db);
      try {
        const response = await app.handle(
          request(path, { chatId, prompt: 'Hello', model: 'operation-test', operationId })
        );
        expect(response.status).toBe(200);
        await waitFor(async () => {
          if (provider.release) provider.release();
          return (await receipt(operationId)).state !== 'running';
        });
        const message = await db
          .selectFrom('messages')
          .select(['id', 'text'])
          .where('chatId', '=', chatId)
          .where('role', '=', 'ai')
          .executeTakeFirst();
        expect(message?.text).toBe('Answer');
        expect(await receipt(operationId)).toMatchObject({
          state: 'completed',
          messageId: message?.id,
        });
      } finally {
        await sql`DROP TRIGGER reject_chat_recency_write`.execute(db);
      }
    }
  );
  it('settles a keyed MangoStudio turn as failed after the user stops it', async () => {
    const operationId = 'stopped-by-user';
    expect((await submit(operationId)).status).toBe(200);
    await waitFor(() => provider.calls === 1);
    const assistant = await db
      .selectFrom('messages')
      .select('id')
      .where('chatId', '=', chatId)
      .where('role', '=', 'ai')
      .executeTakeFirstOrThrow();
    const response = await app.handle(
      request(`/chats/${chatId}/messages/${assistant.id}/recovery/cancel`, {})
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'interrupted' });
    provider.release?.();
    await waitFor(async () => (await receipt(operationId)).state !== 'running');
    expect(await receipt(operationId)).toMatchObject({ state: 'failed', messageId: assistant.id });
    expect((await submit(operationId)).status).toBe(200);
    expect(provider.calls).toBe(1);
  });
  it.each(['/respond', '/respond/stream'])(
    'keeps the detached %s turn owned until its receipt settles',
    async (path) => {
      const operationId = 'shutdown-owned-turn';
      const direct = Promise.withResolvers<void>();
      provider.directGate = direct.promise;
      const response = await app.handle(
        request(path, { chatId, prompt: 'Hello', model: 'operation-test', operationId })
      );
      expect(response.status).toBe(200);
      await waitFor(() => provider.directCalls + provider.calls === 1);

      const draining = drainProductOperationWork();
      try {
        const settledWhileProviderBlocked = await Promise.race([
          draining.then(() => true),
          Bun.sleep(0).then(() => false),
        ]);
        expect(settledWhileProviderBlocked).toBe(false);
      } finally {
        direct.resolve();
        provider.release?.();
        await draining;
        await waitFor(async () => (await receipt(operationId)).state === 'completed');
      }
      expect(await receipt(operationId)).toMatchObject({ state: 'completed' });
    }
  );

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
