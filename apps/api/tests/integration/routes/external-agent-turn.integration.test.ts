import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Chat } from '@mangostudio/shared/chat';
import { EXTERNAL_WORKSPACE_TRUST_VERSION } from '@mangostudio/shared/external-agents';
import { getDb } from '../../../src/db/database';
import { getAppSettings } from '../../../src/modules/app-settings/application/app-settings-service';
import type { AnswerExternalApprovalResult } from '../../../src/modules/external-agents/application/external-approval-registry';
import type { ExternalTurnController } from '../../../src/modules/external-agents/application/external-turn-controller';
import { requiresWorkspaceTrust } from '../../../src/modules/external-agents/application/external-workspace-trust';
import { createExternalAgentTurnRoutes } from '../../../src/modules/external-agents/http/external-agent-turn-routes';
import { insertTestUser } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

let restoreAuth: (() => void) | null = null;
let user = { id: '', name: '', email: '' };
let chatId = '';

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

/** Records what the route delegated, and answers with whatever the test needs. */
function stubController(result: AnswerExternalApprovalResult): {
  readonly controller: ExternalTurnController;
  readonly calls: Parameters<ExternalTurnController['answerApproval']>[0][];
} {
  const calls: Parameters<ExternalTurnController['answerApproval']>[0][] = [];
  return {
    calls,
    controller: {
      start: () => {
        throw new Error('the respond route must never start a turn');
      },
      answerApproval: (input) => {
        calls.push(input);
        return Promise.resolve(result);
      },
    },
  };
}

async function insertExternalChat(
  workdir: string | null = '/work/repo',
  targetId: 'codex' | 'cursor' = 'codex'
): Promise<string> {
  const id = `chat-${crypto.randomUUID()}`;
  await getDb()
    .insertInto('chats')
    .values({
      id,
      title: 'external chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: null,
      userId: user.id,
      runnerKind: 'external',
      runnerTargetId: targetId,
      runnerPermissionLevel: 'full-access',
      runnerApprovalRouting: 'user',
      workdir,
      environmentId: 'local',
    })
    .execute();
  return id;
}

/**
 * A runtime whose only job is to spell a path the way its machine would.
 *
 * `/work/repo` canonicalizes to `/canonical/work/repo` so a test cannot pass by
 * storing whatever the chat happened to carry: the grant has to match what the
 * turn's own canonicalization produces.
 */
function stubRuntimeClient() {
  return Promise.resolve({
    paths: { canonical: (input: string) => `/canonical${input}` },
  } as unknown as Awaited<
    ReturnType<typeof import('../../../src/services/runtime-client').getRuntimeClient>
  >);
}

function mount(
  controller: ExternalTurnController,
  dependencies: Parameters<typeof createExternalAgentTurnRoutes>[1] = {
    resolveRuntimeClient: stubRuntimeClient,
  }
) {
  const { app, restore } = createAuthenticatedApiTestApp(
    user,
    createExternalAgentTurnRoutes(controller, dependencies)
  );
  restoreAuth = restore;
  return app;
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  const created = await insertTestUser();
  user = { id: created.id, name: 'External Turn User', email: `${created.id}@mangostudio.test` };
  chatId = await insertExternalChat();
});

describe('external agent approval route', () => {
  it('delegates the whole decision to the registry', async () => {
    const { controller, calls } = stubController({
      status: 'accepted',
      optionId: 'approve',
      idempotent: false,
    });
    const app = mount(controller);

    const response = await app.handle(
      post(`/chats/${chatId}/external-agent/respond`, {
        requestId: 'req-1',
        optionId: 'approve',
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'accepted', optionId: 'approve' });
    expect(calls).toEqual([{ userId: user.id, chatId, requestId: 'req-1', optionId: 'approve' }]);
  });

  it('maps an unknown option to 400 and an unknown request to 404', async () => {
    const unknownOption = mount(
      stubController({ status: 'rejected', reason: 'unknown-option' }).controller
    );
    const optionResponse = await unknownOption.handle(
      post(`/chats/${chatId}/external-agent/respond`, { requestId: 'req-1', optionId: 'nope' })
    );
    expect(optionResponse.status).toBe(400);
    restoreAuth?.();

    const unknownRequest = mount(
      stubController({ status: 'rejected', reason: 'not-found' }).controller
    );
    const requestResponse = await unknownRequest.handle(
      post(`/chats/${chatId}/external-agent/respond`, { requestId: 'gone', optionId: 'approve' })
    );
    expect(requestResponse.status).toBe(404);
  });

  it('maps an expired or already-resolved approval to 409', async () => {
    const app = mount(stubController({ status: 'rejected', reason: 'expired' }).controller);
    const response = await app.handle(
      post(`/chats/${chatId}/external-agent/respond`, { requestId: 'req-1', optionId: 'approve' })
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: 'rejected', reason: 'expired' });
  });
});

describe('fork with runner', () => {
  it('carries environment and workdir but no transcript, and leaves the source alone', async () => {
    await getDb()
      .insertInto('messages')
      .values({
        id: `message-${crypto.randomUUID()}`,
        chatId,
        role: 'user',
        text: 'the original conversation',
        timestamp: Date.now(),
        imageUrl: null,
        referenceImage: null,
        isGenerating: 0,
        generationTime: null,
        modelName: null,
        styleParams: null,
        interactionMode: 'agent',
        parts: null,
        providerState: null,
      })
      .execute();

    const app = mount(
      stubController({ status: 'accepted', optionId: 'x', idempotent: false }).controller
    );
    const response = await app.handle(
      post(`/chats/${chatId}/fork-with-runner`, {
        runner: { kind: 'mangostudio', agentId: 'default' },
      })
    );

    expect(response.status).toBe(201);
    const { chat } = (await response.json()) as { chat: Chat };
    expect(chat.id).not.toBe(chatId);
    expect(chat.runner).toEqual({ kind: 'mangostudio', agentId: 'default' });
    expect(chat.workdir).toBe('/work/repo');
    expect(chat.environmentId).toBe('local');
    // A fork makes no permission choice of its own: the source's pair was vetted
    // for a different runner, which may not even support it.
    expect(chat.runnerPermissions).toEqual({});

    const forkedMessages = await getDb()
      .selectFrom('messages')
      .select('id')
      .where('chatId', '=', chat.id)
      .execute();
    expect(forkedMessages).toHaveLength(0);

    const source = await getDb()
      .selectFrom('chats')
      .select(['runnerKind', 'runnerTargetId', 'runnerPermissionLevel'])
      .where('id', '=', chatId)
      .executeTakeFirstOrThrow();
    expect(source).toEqual({
      runnerKind: 'external',
      runnerTargetId: 'codex',
      runnerPermissionLevel: 'full-access',
    });
  });

  it('leaves no half-made chat behind when the fork cannot be completed', async () => {
    const app = mount(
      stubController({ status: 'accepted', optionId: 'x', idempotent: false }).controller
    );
    const before = await getDb().selectFrom('chats').select('id').execute();

    const response = await app.handle(
      // `AgentIdSchema` rejects this, so the write fails after `createChat` has
      // already inserted a row — exactly the window the transaction closes.
      post(`/chats/${chatId}/fork-with-runner`, {
        runner: { kind: 'mangostudio', agentId: 'not a valid agent id' },
      })
    );

    expect(response.status).not.toBe(201);
    const after = await getDb().selectFrom('chats').select('id').execute();
    expect(after).toHaveLength(before.length);
  });

  it('refuses to fork a chat the caller does not own', async () => {
    const other = await insertTestUser();
    const foreignChatId = `chat-${crypto.randomUUID()}`;
    await getDb()
      .insertInto('chats')
      .values({
        id: foreignChatId,
        title: 'someone else',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: other.id,
        runnerKind: 'external',
        runnerTargetId: 'codex',
        workdir: '/elsewhere',
        environmentId: 'local',
      })
      .execute();

    const app = mount(
      stubController({ status: 'accepted', optionId: 'x', idempotent: false }).controller
    );
    const response = await app.handle(
      post(`/chats/${foreignChatId}/fork-with-runner`, {
        runner: { kind: 'external', targetId: 'cursor' },
      })
    );
    expect(response.status).toBe(404);
  });
});

describe('trusting a workspace for an external agent', () => {
  const anyController = () =>
    stubController({ status: 'accepted', optionId: 'x', idempotent: false }).controller;

  it('records the canonical path the runtime spells, not the one the chat stored', async () => {
    const cursorChatId = await insertExternalChat('/work/repo', 'cursor');
    const app = mount(anyController());

    const response = await app.handle(
      post(`/chats/${cursorChatId}/external-agent/trust-workspace`, {})
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspacePath: '/canonical/work/repo' });

    const settings = await getAppSettings(getDb(), user.id);
    expect(settings.externalAgentSettings.workspaceTrust).toEqual([
      {
        targetId: 'cursor',
        environmentId: 'local',
        workspacePath: '/canonical/work/repo',
        version: EXTERNAL_WORKSPACE_TRUST_VERSION,
        acceptedAt: expect.any(Number),
      },
    ]);
  });

  it('turns the recorded grant into a turn the gate lets through', async () => {
    const cursorChatId = await insertExternalChat('/work/repo', 'cursor');
    const scope = {
      userId: user.id,
      targetId: 'cursor' as const,
      environmentId: 'local',
      workspacePath: '/canonical/work/repo',
    };
    expect(await requiresWorkspaceTrust(scope, getDb())).toBe(true);

    const app = mount(anyController());
    await app.handle(post(`/chats/${cursorChatId}/external-agent/trust-workspace`, {}));

    expect(await requiresWorkspaceTrust(scope, getDb())).toBe(false);
    // The grant is one directory on one machine, never a blanket.
    expect(
      await requiresWorkspaceTrust({ ...scope, workspacePath: '/canonical/elsewhere' }, getDb())
    ).toBe(true);
  });

  it('never asks about a vendor that has not declared what it loads', async () => {
    // The chat inserted by `beforeEach` is Codex, which is not on the list.
    expect(
      await requiresWorkspaceTrust(
        {
          userId: user.id,
          targetId: 'codex',
          environmentId: 'local',
          workspacePath: '/canonical/work/repo',
        },
        getDb()
      )
    ).toBe(false);
  });

  it('stores nothing for a vendor the gate never consults', async () => {
    // The list is capped, so a row `requiresWorkspaceTrust` will never read is
    // not merely useless: it evicts a grant somebody actually gave, and the
    // user pays for it with a re-prompt on the vendor that does need one.
    const codexChatId = await insertExternalChat('/work/repo', 'codex');
    const app = mount(anyController());

    const response = await app.handle(
      post(`/chats/${codexChatId}/external-agent/trust-workspace`, {})
    );

    expect(response.status).toBe(200);
    const settings = await getAppSettings(getDb(), user.id);
    expect(settings.externalAgentSettings.workspaceTrust).toEqual([]);
  });

  it('refuses a chat with no folder chosen', async () => {
    const cursorChatId = await insertExternalChat(null, 'cursor');
    const app = mount(anyController());

    const response = await app.handle(
      post(`/chats/${cursorChatId}/external-agent/trust-workspace`, {})
    );
    expect(response.status).toBe(400);
  });

  it('refuses a chat the caller does not own', async () => {
    const other = await insertTestUser();
    const foreignChatId = `chat-${crypto.randomUUID()}`;
    await getDb()
      .insertInto('chats')
      .values({
        id: foreignChatId,
        title: 'someone else',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: other.id,
        runnerKind: 'external',
        runnerTargetId: 'cursor',
        workdir: '/elsewhere',
        environmentId: 'local',
      })
      .execute();

    const app = mount(anyController());
    const response = await app.handle(
      post(`/chats/${foreignChatId}/external-agent/trust-workspace`, {})
    );
    expect(response.status).toBe(404);
  });

  it('says the machine is unreachable rather than trusting a path it could not spell', async () => {
    const cursorChatId = await insertExternalChat('/work/repo', 'cursor');
    const app = mount(anyController(), {
      resolveRuntimeClient: () => Promise.reject(new Error('runtime is offline')),
    });

    const response = await app.handle(
      post(`/chats/${cursorChatId}/external-agent/trust-workspace`, {})
    );

    expect(response.status).toBe(503);
    const settings = await getAppSettings(getDb(), user.id);
    expect(settings.externalAgentSettings.workspaceTrust).toEqual([]);
  });
});
