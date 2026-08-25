import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../../../src/db/database';
import { chatRoutes } from '../../../src/modules/chats/http/chat-routes';
import { createTurnCheckpointPart } from '../../../src/modules/generation/application/turn-checkpoint';
import {
  reconcileStaleTurns,
  STALE_TURN_CHECKPOINT_AGE_MS,
} from '../../../src/modules/generation/application/turn-recovery';
import { startStaleTurnReconcileSweep } from '../../../src/server/stale-turn-reconcile-sweep';
import { buildPersistedContextSnapshot } from '../../../src/services/providers/core/context-policy';
import {
  getProvider,
  registerProvider,
} from '../../../src/services/providers/core/provider-registry';
import type { AIProvider } from '../../../src/services/providers/types';
import { insertTestChat, insertTestUser, type UserFixture } from '../../support/factories';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

let TEST_USER!: UserFixture;

beforeAll(async () => {
  TEST_USER = await insertTestUser();
});

let restoreAuth: (() => void) | null = null;
let previousOpenAICompatibleProvider: AIProvider | null = null;
const tempDirs: string[] = [];

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  if (previousOpenAICompatibleProvider) {
    registerProvider(previousOpenAICompatibleProvider);
  }
  previousOpenAICompatibleProvider = null;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mango-chat-workdir-'));
  tempDirs.push(path);
  return path;
}

function registerSummaryProvider(summaryText: string) {
  try {
    previousOpenAICompatibleProvider = getProvider('openai-compatible');
  } catch {
    previousOpenAICompatibleProvider = null;
  }

  registerProvider({
    providerType: 'openai-compatible',
    generateText: () => Promise.resolve({ text: summaryText }),
    listModels: () => Promise.resolve([]),
    validateApiKey: () => Promise.resolve(),
    resolveApiKey: () => Promise.resolve('test-key'),
  });
}

async function insertSummaryConnector(modelId: string) {
  await getDb()
    .insertInto('secret_metadata')
    .values({
      id: `summary-connector-${modelId}-${Date.now()}`,
      name: `Summary ${modelId}`,
      provider: 'openai-compatible',
      configured: 1,
      source: 'config-file',
      maskedSuffix: 'test',
      updatedAt: Date.now(),
      lastValidatedAt: Date.now(),
      lastValidationError: null,
      enabledModels: JSON.stringify([modelId]),
      userId: TEST_USER.id,
      baseUrl: null,
      organizationId: null,
      projectId: null,
    })
    .execute();
}

describe('GET /chats', () => {
  it('returns 401 when not authenticated', async () => {
    const app = createApiTestApp(chatRoutes);
    const response = await app.handle(new Request('http://localhost/chats'));
    expect(response.status).toBe(401);
  });

  it('returns chats array for authenticated user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/chats'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('returns the selected environment without persistence-only fields', async () => {
    const chat = await insertTestChat(TEST_USER.id, { title: 'Environment Chat' });

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/chats'));
    const body = (await response.json()) as Array<Record<string, unknown>>;
    const result = body.find((item) => item.id === chat.id);

    expect(response.status).toBe(200);
    expect(result?.environmentId).toBe('local');
    expect(result).not.toHaveProperty('userId');
    expect(result).not.toHaveProperty('lastProviderState');
    expect(result).not.toHaveProperty('lastContextState');
  });

  it('returns persisted context info without provider internals', async () => {
    const db = getDb();
    const chatId = `context-list-${Date.now()}`;
    const lastContextState = JSON.stringify(
      buildPersistedContextSnapshot(
        {
          estimatedInputTokens: 90_000,
          contextLimit: 100_000,
          estimatedUsageRatio: 0.9,
          mode: 'replay',
        },
        123456
      )
    );

    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Context Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: TEST_USER.id,
        lastContextState,
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/chats'));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Array<Record<string, unknown>>;
    const chat = body.find((item) => item.id === chatId);

    expect(chat?.contextInfo).toMatchObject({
      estimatedInputTokens: 90_000,
      contextLimit: 100_000,
      estimatedUsageRatio: 0.9,
      mode: 'replay',
      severity: 'warning',
    });
    expect(chat).not.toHaveProperty('lastProviderState');
    expect(chat).not.toHaveProperty('lastContextState');
  });
});

describe('POST /chats', () => {
  it('returns 401 when not authenticated', async () => {
    const app = createApiTestApp(chatRoutes);
    const response = await app.handle(
      new Request('http://localhost/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test Chat' }),
      })
    );
    expect(response.status).toBe(401);
  });

  it('returns 422 when title is missing', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    expect(response.status).toBe(422);
  });

  it('creates a chat and returns server-generated id', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test Chat' }),
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('id');
    expect(typeof body.id).toBe('string');
    expect((body.id as string).length).toBeGreaterThan(0);
    expect(body.environmentId).toBe('local');
    expect(body).not.toHaveProperty('userId');
    expect(body).not.toHaveProperty('lastProviderState');
    expect(body).not.toHaveProperty('lastContextState');
  });

  it('writes a chat_created activity row scoped to the new chat', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Activity Chat' }),
      })
    );
    const body = (await response.json()) as { id: string };
    // The write is fire-and-forget from the use case; one macrotask turn is
    // enough for bun:sqlite's synchronous driver to have settled it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const row = await getDb()
      .selectFrom('activity_events')
      .selectAll()
      .where('userId', '=', TEST_USER.id)
      .where('chatId', '=', body.id)
      .where('kind', '=', 'chat_created')
      .executeTakeFirst();

    expect(row).toBeDefined();
    expect(JSON.parse(row?.payloadJson ?? '{}')).toEqual({ title: 'Activity Chat' });

    await getDb()
      .deleteFrom('activity_events')
      .where('id', '=', row?.id ?? '')
      .execute();
  });

  it('does not accept client-supplied id in body', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const clientId = 'client-supplied-id';
    const response = await app.handle(
      new Request('http://localhost/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test Chat', id: clientId }),
      })
    );

    // Should succeed but the body schema ignores the id field — server generates its own
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('id');
    expect(typeof body.id).toBe('string');
    expect(body.id).not.toBe(clientId);
  });
});

describe('POST /chats/title-suggestion', () => {
  it('generates a sanitized chat title from the selected model', async () => {
    registerSummaryProvider('Title: "Deterministic Testing"');
    await insertSummaryConnector('chat-title-model');

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/chats/title-suggestion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Explain deterministic testing strategies for Vitest suites.',
          model: 'chat-title-model',
        }),
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ title: 'Deterministic Testing' });
  });

  it('returns 400 when the prompt is blank', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/chats/title-suggestion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '   ', model: 'chat-title-model' }),
      })
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'VALIDATION' });
  });
});

describe('DELETE /chats/:id', () => {
  it('returns 401 when not authenticated', async () => {
    const app = createApiTestApp(chatRoutes);
    const response = await app.handle(
      new Request('http://localhost/chats/some-id', { method: 'DELETE' })
    );
    expect(response.status).toBe(401);
  });

  it('deletes an owned chat and returns success', async () => {
    const db = getDb();
    const chatId = `delete-target-${Date.now()}`;
    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'To Be Deleted',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: TEST_USER.id,
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/chats/${chatId}`, { method: 'DELETE' })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ success: true });

    const row = await db
      .selectFrom('chats')
      .selectAll()
      .where('id', '=', chatId)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it('returns success even when chat does not exist (no-op delete)', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/chats/nonexistent-chat-id', { method: 'DELETE' })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ success: true });
  });
});

describe('PUT /chats/:id', () => {
  it('returns 401 when not authenticated', async () => {
    const app = createApiTestApp(chatRoutes);
    const response = await app.handle(
      new Request('http://localhost/chats/some-id', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated Title' }),
      })
    );
    expect(response.status).toBe(401);
  });

  it('updates a chat title and returns success', async () => {
    const db = getDb();
    const chatId = `update-target-${Date.now()}`;
    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Original Title',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: TEST_USER.id,
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/chats/${chatId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated Title' }),
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ success: true });

    const row = await db
      .selectFrom('chats')
      .selectAll()
      .where('id', '=', chatId)
      .executeTakeFirst();
    expect(row?.title).toBe('Updated Title');
  });

  it('switches a chat without turns to an external runner', async () => {
    const db = getDb();
    const chatId = `external-runner-${Date.now()}`;
    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'External Runner Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: TEST_USER.id,
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/chats/${chatId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runner: { kind: 'external', targetId: 'codex' } }),
      })
    );

    expect(response.status).toBe(200);
    expect(
      await db
        .selectFrom('chats')
        .select(['runnerKind', 'runnerAgentId', 'runnerTargetId'])
        .where('id', '=', chatId)
        .executeTakeFirst()
    ).toEqual({ runnerKind: 'external', runnerAgentId: null, runnerTargetId: 'codex' });
  });

  it('persists the runner permission pair', async () => {
    const db = getDb();
    const chatId = `runner-permissions-${Date.now()}`;
    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Permissions Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        runnerKind: 'external',
        // Null, not the column default: `runnerColumns` clears the companion
        // column the kind does not use, so a fixture that kept 'default' would
        // be a row shape the hub never writes.
        runnerAgentId: null,
        runnerTargetId: 'codex',
        userId: TEST_USER.id,
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/chats/${chatId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runnerPermissions: { level: 'read-only', routing: 'user' } }),
      })
    );

    expect(response.status).toBe(200);
    expect(
      await db
        .selectFrom('chats')
        .select(['runnerPermissionLevel', 'runnerApprovalRouting'])
        .where('id', '=', chatId)
        .executeTakeFirst()
    ).toEqual({ runnerPermissionLevel: 'read-only', runnerApprovalRouting: 'user' });
  });

  it('sets and clears a validated working directory', async () => {
    const db = getDb();
    const chatId = `workdir-target-${Date.now()}`;
    const workdir = await createTempDir();
    await mkdir(join(workdir, 'project'));
    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Workdir Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: TEST_USER.id,
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;
    const update = (value: string | null) =>
      app.handle(
        new Request(`http://localhost/chats/${chatId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workdir: value }),
        })
      );

    const setResponse = await update(join(workdir, 'project'));
    expect(setResponse.status).toBe(200);
    expect(
      await db.selectFrom('chats').select('workdir').where('id', '=', chatId).executeTakeFirst()
    ).toEqual({ workdir: join(workdir, 'project') });

    const clearResponse = await update(null);
    expect(clearResponse.status).toBe(200);
    expect(
      await db.selectFrom('chats').select('workdir').where('id', '=', chatId).executeTakeFirst()
    ).toEqual({ workdir: null });
  });

  it('rejects a workdir that is missing or not a directory', async () => {
    const db = getDb();
    const chatId = `invalid-workdir-${Date.now()}`;
    const root = await createTempDir();
    const file = join(root, 'file.txt');
    await writeFile(file, 'file');
    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Invalid Workdir Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: TEST_USER.id,
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;
    const update = (workdir: string) =>
      app.handle(
        new Request(`http://localhost/chats/${chatId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workdir }),
        })
      );

    const missing = await update(join(root, 'missing'));
    const notDirectory = await update(file);

    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({ code: 'VALIDATION' });
    expect(notDirectory.status).toBe(422);
    expect(await notDirectory.json()).toMatchObject({ code: 'VALIDATION' });
  });

  it('selects only owned environments and clears a stale workdir on change', async () => {
    const db = getDb();
    const suffix = Date.now();
    const environmentId = `remote-${suffix}`;
    await db
      .insertInto('environments')
      .values({
        id: environmentId,
        userId: TEST_USER.id,
        name: 'Remote',
        transportKind: 'stdio',
        configJson: '{}',
        enabled: 1,
        allowInstalls: 0,
        createdAt: suffix,
        updatedAt: suffix,
      })
      .execute();
    const chat = await insertTestChat(TEST_USER.id, { title: 'Environment Target' });
    await db
      .updateTable('chats')
      .set({ workdir: '/local-only/path' })
      .where('id', '=', chat.id)
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;
    const update = (id: string, environment: string) =>
      app.handle(
        new Request(`http://localhost/chats/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ environmentId: environment }),
        })
      );

    const selected = await update(chat.id, environmentId);
    expect(selected.status).toBe(200);
    expect(
      await db
        .selectFrom('chats')
        .select(['environmentId', 'workdir'])
        .where('id', '=', chat.id)
        .executeTakeFirst()
    ).toEqual({ environmentId, workdir: null });

    const missing = await update(chat.id, `missing-${suffix}`);
    expect(missing.status).toBe(422);
    expect(await missing.json()).toEqual({
      error: `Environment "missing-${suffix}" was not found.`,
      code: 'VALIDATION',
    });

    const missingChat = await update(`missing-chat-${suffix}`, 'local');
    expect(missingChat.status).toBe(404);
    expect(await missingChat.json()).toEqual({
      error: 'Chat not found',
      code: 'NOT_FOUND',
    });

    // The environment check shares the write's transaction, so a rejected
    // selection must not leave the rest of the same request persisted.
    const rejected = await app.handle(
      new Request(`http://localhost/chats/${chat.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environmentId: `missing-${suffix}`, title: 'Should not persist' }),
      })
    );
    expect(rejected.status).toBe(422);
    expect(
      await db
        .selectFrom('chats')
        .select(['environmentId', 'title'])
        .where('id', '=', chat.id)
        .executeTakeFirst()
    ).toEqual({ environmentId, title: 'Environment Target' });
  });

  it('returns 422 when body is missing required schema fields', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/chats/some-id', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      })
    );

    // Elysia returns 400 on body parse errors, 422 on schema validation errors
    expect([400, 422]).toContain(response.status);
  });
});

describe('POST /chats/:id/compact', () => {
  it('compacts a chat into a summary message without removing original history', async () => {
    registerSummaryProvider('Compact summary');
    await insertSummaryConnector('summary-model');

    const db = getDb();
    const chatId = `compact-${Date.now()}`;
    // Compact writes Date.now(); keep fixtures older so the summary sorts last.
    const base = Date.now() - 10_000;

    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Compact Me',
        createdAt: base,
        updatedAt: base,
        model: null,
        textModel: 'summary-model',
        userId: TEST_USER.id,
        lastProviderState: 'stale-cursor',
      })
      .execute();

    await db
      .insertInto('messages')
      .values([
        {
          id: `compact-user-${chatId}`,
          chatId,
          role: 'user',
          text: 'Summarize this discussion',
          timestamp: base + 1,
          isGenerating: 0,
          interactionMode: 'chat',
        },
        {
          id: `compact-ai-${chatId}`,
          chatId,
          role: 'ai',
          text: 'Here is the long answer',
          timestamp: base + 2,
          isGenerating: 0,
          interactionMode: 'chat',
        },
      ])
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/chats/${chatId}/compact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'summary-model' }),
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      chatId: string;
      summaryMessageId: string;
      contextInfo: Record<string, unknown> | null;
    };
    expect(body.chatId).toBe(chatId);
    expect(body.contextInfo).toMatchObject({ mode: 'compacted' });

    const messages = await db
      .selectFrom('messages')
      .select(['text', 'parts'])
      .where('chatId', '=', chatId)
      .orderBy('timestamp', 'asc')
      .execute();

    expect(messages).toHaveLength(3);
    expect(messages[0]?.text).toBe('Summarize this discussion');
    expect(messages[1]?.text).toBe('Here is the long answer');
    expect(messages[2]?.text).toBe('Compact summary');
    expect(messages[2]?.parts).toContain('chat_compacted');

    const chat = await db
      .selectFrom('chats')
      .select(['lastProviderState', 'lastContextState'])
      .where('id', '=', chatId)
      .executeTakeFirst();

    expect(chat?.lastProviderState).toBeNull();
    expect(chat?.lastContextState).toContain('compacted');
  });
});

describe('POST /chats/:id/summarize-to-new-chat', () => {
  it('creates a new chat seeded with a summary and keeps the source chat intact', async () => {
    registerSummaryProvider('Handoff summary');
    await insertSummaryConnector('summary-model-2');

    const db = getDb();
    const sourceChatId = `handoff-${Date.now()}`;
    const base = Date.now();

    await db
      .insertInto('chats')
      .values({
        id: sourceChatId,
        title: 'Source Chat',
        createdAt: base,
        updatedAt: base,
        model: null,
        textModel: 'summary-model-2',
        imageModel: 'image-model',
        runnerKind: 'mangostudio',
        runnerAgentId: 'user:reviewer',
        workdir: '/workspace/source-project',
        restrictToolsToWorkdir: 1,
        userId: TEST_USER.id,
      })
      .execute();

    await db
      .insertInto('messages')
      .values([
        {
          id: `handoff-user-${sourceChatId}`,
          chatId: sourceChatId,
          role: 'user',
          text: 'Move this chat forward',
          timestamp: base + 1,
          isGenerating: 0,
          interactionMode: 'chat',
        },
        {
          id: `handoff-ai-${sourceChatId}`,
          chatId: sourceChatId,
          role: 'ai',
          text: 'Previous answer',
          timestamp: base + 2,
          isGenerating: 0,
          interactionMode: 'chat',
        },
      ])
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/chats/${sourceChatId}/summarize-to-new-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'summary-model-2' }),
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      chatId: string;
      summaryMessageId: string;
      contextInfo: Record<string, unknown> | null;
    };
    expect(body.chatId).not.toBe(sourceChatId);
    expect(body.contextInfo).toMatchObject({ mode: 'compacted' });

    const sourceMessages = await db
      .selectFrom('messages')
      .select('id')
      .where('chatId', '=', sourceChatId)
      .execute();
    expect(sourceMessages).toHaveLength(2);

    const newChat = await db
      .selectFrom('chats')
      .select([
        'id',
        'title',
        'textModel',
        'imageModel',
        'runnerKind',
        'runnerAgentId',
        'workdir',
        'restrictToolsToWorkdir',
      ])
      .where('id', '=', body.chatId)
      .executeTakeFirst();
    expect(newChat).toMatchObject({
      id: body.chatId,
      title: 'Source Chat',
      textModel: 'summary-model-2',
      imageModel: 'image-model',
      runnerKind: 'mangostudio',
      runnerAgentId: 'user:reviewer',
      workdir: '/workspace/source-project',
      restrictToolsToWorkdir: 1,
    });

    const newMessages = await db
      .selectFrom('messages')
      .select(['text', 'parts'])
      .where('chatId', '=', body.chatId)
      .execute();
    expect(newMessages).toHaveLength(1);
    expect(newMessages[0]?.text).toBe('Handoff summary');
    expect(newMessages[0]?.parts).toContain('summary_handoff');
  });
});

describe('GET /chats/:id/messages', () => {
  it('returns 401 when not authenticated', async () => {
    const app = createApiTestApp(chatRoutes);
    const response = await app.handle(new Request('http://localhost/chats/some-id/messages'));
    expect(response.status).toBe(401);
  });

  it('returns 404 when chat does not belong to the user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/chats/nonexistent-chat/messages')
    );

    expect(response.status).toBe(404);
  });

  it('returns messages array and nextCursor for an owned chat', async () => {
    const db = getDb();
    const chatId = `messages-target-${Date.now()}`;
    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Messages Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: TEST_USER.id,
      })
      .execute();

    const now = Date.now();
    await db
      .insertInto('messages')
      .values([
        {
          id: `msg-a-${chatId}`,
          chatId,
          role: 'user',
          text: 'Hello',
          timestamp: now,
          isGenerating: 0,
          interactionMode: 'chat',
        },
        {
          id: `msg-b-${chatId}`,
          chatId,
          role: 'ai',
          text: 'World',
          timestamp: now + 1,
          isGenerating: 0,
          interactionMode: 'chat',
        },
      ])
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/chats/${chatId}/messages?limit=50`)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { messages: unknown[]; nextCursor: string | null };
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBe(2);
    expect(body.nextCursor).toBeNull();
  });

  it('does not reconcile stale turns while reading messages', async () => {
    const db = getDb();
    const now = Date.now();
    const chatId = `messages-stale-turn-${now}`;
    const messageId = `stale-turn-${now}`;
    const checkpoint = createTurnCheckpointPart({
      turnId: messageId,
      startedAt: now - STALE_TURN_CHECKPOINT_AGE_MS - 1,
      provider: 'openai',
      modelName: 'gpt-test',
      agentId: 'default',
    });
    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Stale Turn Chat',
        createdAt: now,
        updatedAt: now,
        model: null,
        userId: TEST_USER.id,
      })
      .execute();
    await db
      .insertInto('messages')
      .values({
        id: messageId,
        chatId,
        role: 'ai',
        text: 'durable partial response',
        timestamp: now,
        isGenerating: 1,
        interactionMode: 'chat',
        parts: JSON.stringify([checkpoint]),
      })
      .execute();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request(`http://localhost/chats/${chatId}/messages`));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: Array<{ id: string; isGenerating: boolean }>;
    };
    expect(body.messages).toContainEqual(
      expect.objectContaining({ id: messageId, isGenerating: true })
    );
    let row = await db
      .selectFrom('messages')
      .select('isGenerating')
      .where('id', '=', messageId)
      .executeTakeFirstOrThrow();
    expect(row.isGenerating).toBe(1);

    const sweep = startStaleTurnReconcileSweep(() =>
      reconcileStaleTurns({ reasonCode: 'unknown', isActive: () => false }, db)
    );
    try {
      await sweep.run();
    } finally {
      await sweep.stop();
    }
    row = await db
      .selectFrom('messages')
      .select('isGenerating')
      .where('id', '=', messageId)
      .executeTakeFirstOrThrow();
    expect(row.isGenerating).toBe(0);
  });

  it('returns persisted context info on the first messages page', async () => {
    const db = getDb();
    const chatId = `messages-context-${Date.now()}`;
    const lastContextState = JSON.stringify(
      buildPersistedContextSnapshot(
        {
          estimatedInputTokens: 12_000,
          contextLimit: 65_536,
          estimatedUsageRatio: 12_000 / 65_536,
          mode: 'replay',
        },
        123456
      )
    );

    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Messages Context Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: TEST_USER.id,
        lastContextState,
      })
      .execute();

    await db
      .insertInto('messages')
      .values({
        id: `msg-context-${chatId}`,
        chatId,
        role: 'ai',
        text: 'Context response',
        timestamp: Date.now(),
        isGenerating: 0,
        interactionMode: 'chat',
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/chats/${chatId}/messages?limit=50`)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { contextInfo?: Record<string, unknown> | null };
    expect(body.contextInfo).toMatchObject({
      estimatedInputTokens: 12_000,
      contextLimit: 65_536,
      mode: 'replay',
      severity: 'normal',
    });
  });

  it('returns attachments linked to messages', async () => {
    const db = getDb();
    const now = Date.now();
    const chatId = `messages-attachments-${now}`;
    const messageId = `msg-attachments-${now}`;
    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Messages Attachments Chat',
        createdAt: now,
        updatedAt: now,
        model: null,
        userId: TEST_USER.id,
      })
      .execute();

    await db
      .insertInto('messages')
      .values({
        id: messageId,
        chatId,
        role: 'user',
        text: 'Please inspect the reference.',
        timestamp: now,
        isGenerating: 0,
        interactionMode: 'chat',
      })
      .execute();

    await db
      .insertInto('chat_attachments')
      .values({
        id: `attachment-${now}`,
        userId: TEST_USER.id,
        chatId,
        messageId,
        originalName: 'reference.png',
        storedName: `attachment-${now}-reference.png`,
        relativePath: `Messages-Attachments-Chat_${chatId}/${now}/attachment-${now}-reference.png`,
        url: `/uploads/Messages-Attachments-Chat_${chatId}/${now}/attachment-${now}-reference.png`,
        mimeType: 'image/png',
        sizeBytes: 128,
        kind: 'image',
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/chats/${chatId}/messages?limit=50`)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: Array<{ id: string; attachments?: Array<Record<string, unknown>> }>;
    };
    const message = body.messages.find((candidate) => candidate.id === messageId);
    expect(message?.attachments).toEqual([
      expect.objectContaining({
        chatId,
        messageId,
        originalName: 'reference.png',
        mimeType: 'image/png',
        kind: 'image',
      }),
    ]);
  });

  it('returns nextCursor when results exceed the limit', async () => {
    const db = getDb();
    const chatId = `paginated-${Date.now()}`;
    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Paginated Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: TEST_USER.id,
      })
      .execute();

    const base = Date.now();
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `pagmsg-${chatId}-${i}`,
      chatId,
      role: 'user' as const,
      text: `Message ${i}`,
      timestamp: base + i,
      isGenerating: 0 as const,
      interactionMode: 'chat' as const,
    }));
    await db.insertInto('messages').values(rows).execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, chatRoutes);
    restoreAuth = restore;

    // Fetch only 2 of 3 messages to trigger cursor
    const response = await app.handle(
      new Request(`http://localhost/chats/${chatId}/messages?limit=2`)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { messages: unknown[]; nextCursor: string | null };
    expect(body.messages.length).toBe(2);
    expect(body.nextCursor).not.toBeNull();
  });
});
