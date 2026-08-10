import { beforeEach, describe, expect, it } from 'bun:test';
import type {
  ExternalAgentDescriptor,
  ExternalSupportedConfiguration,
} from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import type { StreamChunk } from '@mangostudio/shared/streaming';
import { getDb } from '../../../../src/db/database';
import type { OwnedChatRecord } from '../../../../src/modules/chats/infrastructure/chat-repository';
import { createExternalApprovalRegistry } from '../../../../src/modules/external-agents/application/external-approval-registry';
import { createExternalSessionManager } from '../../../../src/modules/external-agents/application/external-session-manager';
import { createExternalTurnConfigurationResolver } from '../../../../src/modules/external-agents/application/external-turn-configuration';
import { createExternalTurnController } from '../../../../src/modules/external-agents/application/external-turn-controller';
import { createExternalTurnStream } from '../../../../src/modules/external-agents/application/external-turn-stream';
import { grantWorkspaceTrust } from '../../../../src/modules/external-agents/application/external-workspace-trust';
import {
  cancelActiveTurn,
  findActiveTurnByChat,
} from '../../../../src/modules/generation/application/active-turn-registry';
import {
  createFakeExternalRuntime,
  type FakeExternalRuntime,
} from '../../../support/external-agents/fake-external-runtime';
import { insertTestUser } from '../../../support/factories';

const EVERY_PAIR: readonly ExternalSupportedConfiguration[] = [
  { level: 'read-only', routing: 'user', supported: true, unattended: false },
  { level: 'default', routing: 'user', supported: true, unattended: false },
  { level: 'full-access', routing: 'user', supported: true, unattended: true },
  {
    level: 'default',
    routing: 'auto-review',
    supported: false,
    unattended: true,
    unsupportedReasonKey: 'externalAgents.unsupported.codexProfileDisallowed',
  },
];

function descriptor(overrides: Partial<ExternalAgentDescriptor> = {}): ExternalAgentDescriptor {
  return {
    targetId: 'codex',
    environmentId: 'local',
    installed: true,
    authState: 'signed-in',
    capabilities: { ...NO_EXTERNAL_AGENT_CAPABILITIES, structuredStreaming: true },
    supportedConfigurations: EVERY_PAIR,
    account: { label: 'someone', fingerprint: 'fingerprint-a' },
    ...overrides,
  };
}

let userId = '';
let chatId = '';

async function insertExternalChat(
  permissions: { level?: string; routing?: string } = { level: 'default', routing: 'user' }
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
      userId,
      runnerKind: 'external',
      runnerTargetId: 'codex',
      runnerPermissionLevel: permissions.level ?? null,
      runnerApprovalRouting: permissions.routing ?? null,
      workdir: '/work/repo',
      environmentId: 'local',
    })
    .execute();
  return id;
}

function chatRecord(overrides: Partial<OwnedChatRecord> = {}): OwnedChatRecord {
  return {
    runner: { kind: 'external', targetId: 'codex' },
    runnerPermissions: { level: 'default', routing: 'user' },
    workdir: '/work/repo',
    environmentId: 'local',
    restrictToolsToWorkdir: null,
    ...overrides,
  };
}

function harness(options: { readonly agents?: readonly ExternalAgentDescriptor[] } = {}) {
  const runtime = createFakeExternalRuntime();
  const sessions = createExternalSessionManager({
    resolveRuntimeClient: () => Promise.resolve(runtime.client),
    newSessionId: () => `session-${crypto.randomUUID()}`,
  });
  const approvals = createExternalApprovalRegistry();
  const controller = createExternalTurnController({ sessions, approvals });
  const resolveConfiguration = createExternalTurnConfigurationResolver({
    resolveRuntimeClient: () => Promise.resolve(runtime.client),
    discovery: {
      listExternalAgents: () => Promise.resolve(options.agents ?? [descriptor()]),
      resetCache: () => undefined,
    },
  });
  const stream = createExternalTurnStream({ controller, resolveConfiguration });
  return { runtime, controller, approvals, resolveConfiguration, stream };
}

/** Reads SSE frames off the response until the stream closes. */
async function readChunks(response: Response): Promise<StreamChunk[]> {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as StreamChunk);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function waitForTurnStart(runtime: FakeExternalRuntime): Promise<void> {
  return waitFor(() => runtime.calls.turn.length === 1, 'the turn to reach the runtime');
}

beforeEach(async () => {
  const user = await insertTestUser();
  userId = user.id;
  chatId = await insertExternalChat();
});

describe('external turn configuration', () => {
  it('refuses a pair the adapter did not vet', async () => {
    const { resolveConfiguration } = harness();
    const resolution = await resolveConfiguration({
      userId,
      chat: chatRecord({ runnerPermissions: { level: 'default', routing: 'auto-review' } }),
      targetId: 'codex',
      workdir: '/work/repo',
    });
    expect(resolution.ok).toBe(false);
  });

  it('resolves an unmade choice to the restrictive end of both axes', async () => {
    const { resolveConfiguration } = harness();
    const resolution = await resolveConfiguration({
      userId,
      chat: chatRecord({ runnerPermissions: {} }),
      targetId: 'codex',
      workdir: '/work/repo',
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.configuration.level).toBe('read-only');
    expect(resolution.configuration.routing).toBe('user');
  });

  it('canonicalizes the workspace with the target machine path semantics', async () => {
    const { resolveConfiguration } = harness();
    const resolution = await resolveConfiguration({
      userId,
      chat: chatRecord(),
      targetId: 'codex',
      workdir: '/work/repo///',
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.canonicalWorkspacePath).toBe('/work/repo');
    expect(resolution.configuration.workspaceRoots).toEqual(['/work/repo']);
    expect(resolution.vendorAccountFingerprint).toBe('fingerprint-a');
  });

  it('falls back to the vendor default when the request names a model the catalog lost', async () => {
    const { resolveConfiguration } = harness({
      agents: [
        descriptor({
          models: [
            { id: 'gpt-5.6-sol', isDefault: true, supportedReasoningEfforts: [{ id: 'high' }] },
            { id: 'gpt-5.6-mini' },
          ],
        }),
      ],
    });
    const resolution = await resolveConfiguration({
      userId,
      chat: chatRecord(),
      targetId: 'codex',
      workdir: '/work/repo',
      request: { model: 'a-model-that-was-removed', effort: 'nonsense' },
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.configuration.model).toBe('gpt-5.6-sol');
    // The requested effort belongs to no listed model, so the chosen model's own
    // catalog decides — and it advertises no default, so nothing is sent.
    expect(resolution.configuration.effort).toBeUndefined();
  });

  it('refuses a target discovery reports as unavailable', async () => {
    const { resolveConfiguration } = harness({
      agents: [descriptor({ unavailableReason: 'signed-out' })],
    });
    const resolution = await resolveConfiguration({
      userId,
      chat: chatRecord(),
      targetId: 'codex',
      workdir: '/work/repo',
    });
    expect(resolution.ok).toBe(false);
  });
});

describe('external turn stream', () => {
  it('streams a text turn as external chunks and finishes with done', async () => {
    const { runtime, stream } = harness();
    const result = await stream(
      {
        userId,
        chat: chatRecord(),
        chatId,
        prompt: 'summarize the repo',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reading = readChunks(result.response);
    await waitForTurnStart(runtime);
    runtime.emit({ type: 'text_delta', text: 'a repo' });
    runtime.emit({
      type: 'activity_started',
      callId: 'call-1',
      activity: { name: 'shell', kind: 'command', title: 'ls' },
    });
    runtime.emit({ type: 'activity_completed', callId: 'call-1', result: { status: 'completed' } });
    runtime.emit({ type: 'usage', usage: { inputTokens: 11 } });
    runtime.emit({ type: 'completed' });

    const chunks = await reading;
    const types = chunks.map((chunk) => chunk.type);
    expect(types).toEqual([
      'external_session_started',
      'user_message_id',
      'assistant_message_id',
      'external_text',
      'external_activity_started',
      'external_activity_completed',
      'external_usage',
      'external_turn_completed',
      'done',
    ]);
    // The vendor's own session handle never reaches the client.
    expect(JSON.stringify(chunks)).not.toContain('native-session-1');
  });

  it('streams an approval request and its resolution', async () => {
    const { runtime, controller, approvals, stream } = harness();
    const result = await stream(
      {
        userId,
        chat: chatRecord(),
        chatId,
        prompt: 'delete the build folder',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    if (!result.ok) throw new Error('the send was refused');

    const reading = readChunks(result.response);
    await waitForTurnStart(runtime);
    runtime.emit({
      type: 'approval_requested',
      request: {
        requestId: 'req-1',
        kind: 'command',
        title: 'Run `rm -rf build`',
        options: [
          { id: 'approve', rawLabel: 'Approve for this session', isDestructive: false },
          { id: 'deny', rawLabel: 'Deny', isDestructive: true },
        ],
        expiresAtMs: Date.now() + 60_000,
      },
    });
    // The registry binds the approval when the envelope is applied, which the
    // emit above only *schedules*. Waiting on the registry itself is what makes
    // the rejection below a statement about the option id rather than a race
    // with an approval that has not registered yet.
    await waitFor(() => approvals.pendingCount(chatId) === 1, 'the approval to bind');

    const rejected = await controller.answerApproval({
      userId,
      chatId,
      requestId: 'req-1',
      optionId: 'not-an-option',
    });
    expect(rejected).toEqual({ status: 'rejected', reason: 'unknown-option' });

    const accepted = await controller.answerApproval({
      userId,
      chatId,
      requestId: 'req-1',
      optionId: 'approve',
    });
    expect(accepted.status).toBe('accepted');
    expect(runtime.calls.respond).toHaveLength(1);
    expect(runtime.calls.respond[0]?.optionId).toBe('approve');

    runtime.emit({ type: 'completed' });
    const chunks = await reading;
    const request = chunks.find((chunk) => chunk.type === 'external_approval_request');
    expect(request).toMatchObject({
      requestId: 'req-1',
      options: [
        { id: 'approve', rawLabel: 'Approve for this session', isDestructive: false },
        { id: 'deny', rawLabel: 'Deny', isDestructive: true },
      ],
    });
  });

  it('binds an answer to the live turn without the client naming it', async () => {
    const { runtime, controller, approvals, stream } = harness();
    const result = await stream(
      {
        userId,
        chat: chatRecord(),
        chatId,
        prompt: 'delete the build folder',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    if (!result.ok) throw new Error('the send was refused');
    const reading = readChunks(result.response);
    await waitForTurnStart(runtime);
    runtime.emit({
      type: 'approval_requested',
      request: {
        requestId: 'req-1',
        kind: 'command',
        title: 'Run `rm -rf build`',
        options: [{ id: 'approve', isDestructive: false }],
        expiresAtMs: Date.now() + 60_000,
      },
    });
    await waitFor(() => approvals.pendingCount(chatId) === 1, 'the approval to bind');

    // The client sends only the request and option ids; the session and vendor
    // turn ids are server-owned and never cross the wire. The controller has to
    // supply them, or the registry's binding check is vacuous.
    const accepted = await controller.answerApproval({
      userId,
      chatId,
      requestId: 'req-1',
      optionId: 'approve',
    });
    expect(accepted.status).toBe('accepted');
    expect(runtime.calls.respond[0]).toMatchObject({ nativeTurnId: 'native-turn-1' });

    runtime.emit({ type: 'completed' });
    await reading;

    // Once the turn is gone the same answer no longer binds to anything, so a
    // card left over from it cannot reach a later turn.
    const afterwards = await controller.answerApproval({
      userId,
      chatId,
      requestId: 'req-1',
      optionId: 'approve',
    });
    expect(afterwards.status).toBe('rejected');
  });

  it('preserves a vendor error structure on the wire', async () => {
    const { runtime, stream } = harness();
    const result = await stream(
      {
        userId,
        chat: chatRecord(),
        chatId,
        prompt: 'break',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    if (!result.ok) throw new Error('the send was refused');

    const reading = readChunks(result.response);
    await waitForTurnStart(runtime);
    runtime.emit({
      type: 'error',
      error: {
        code: 'vendor_failed',
        message: 'sandbox denied',
        vendorCode: 'E_SANDBOX',
        retryable: false,
      },
    });

    const chunks = await reading;
    expect(chunks.find((chunk) => chunk.type === 'external_error')).toMatchObject({
      error: { code: 'vendor_failed', vendorCode: 'E_SANDBOX', retryable: false },
    });
  });

  it('reports the terminal reason for a cancel and for a dropped runtime', async () => {
    const cancelled = harness();
    const cancelledResult = await cancelled.stream(
      {
        userId,
        chat: chatRecord(),
        chatId,
        prompt: 'long job',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    if (!cancelledResult.ok) throw new Error('the send was refused');
    const cancelledReading = readChunks(cancelledResult.response);
    await waitForTurnStart(cancelled.runtime);
    expect(cancelActiveTurnForChat(chatId)).toBe(true);
    const cancelledChunks = await cancelledReading;
    expect(cancelledChunks).toContainEqual({
      type: 'external_turn_completed',
      reason: 'cancelled-by-user',
      done: false,
    });
    expect(cancelledChunks.at(-1)?.type).toBe('done');

    const droppedChatId = await insertExternalChat();
    const dropped = harness();
    const droppedResult = await dropped.stream(
      {
        userId,
        chat: chatRecord(),
        chatId: droppedChatId,
        prompt: 'long job',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    if (!droppedResult.ok) throw new Error('the send was refused');
    const droppedReading = readChunks(droppedResult.response);
    await waitForTurnStart(dropped.runtime);
    dropped.runtime.dropConnection();
    const droppedChunks = await droppedReading;
    expect(droppedChunks).toContainEqual({
      type: 'external_turn_completed',
      reason: 'runtime-disconnected',
      done: false,
    });
  });

  it('refuses a chat with no workspace before any header is written', async () => {
    const { stream } = harness();
    const result = await stream(
      {
        userId,
        chat: chatRecord({ workdir: null }),
        chatId,
        prompt: 'anything',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    expect(result).toMatchObject({ ok: false, failure: { kind: 'validation' } });
  });

  it('refuses an unsupported permission pair with a conflict rather than a stream', async () => {
    const { stream } = harness();
    const result = await stream(
      {
        userId,
        chat: chatRecord({ runnerPermissions: { level: 'default', routing: 'auto-review' } }),
        chatId,
        prompt: 'anything',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    expect(result).toMatchObject({ ok: false, failure: { kind: 'unsupported' } });
  });

  it('refuses a second send while a turn is live', async () => {
    const { runtime, stream } = harness();
    const first = await stream(
      {
        userId,
        chat: chatRecord(),
        chatId,
        prompt: 'first',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    if (!first.ok) throw new Error('the first send was refused');
    const reading = readChunks(first.response);
    await waitForTurnStart(runtime);

    const second = await stream(
      {
        userId,
        chat: chatRecord(),
        chatId,
        prompt: 'second',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    expect(second).toMatchObject({ ok: false, failure: { kind: 'conflict' } });

    runtime.emit({ type: 'completed' });
    await reading;
  });
});

/** Cancels whatever turn the chat currently holds, exactly as the stop endpoint does. */
function cancelActiveTurnForChat(id: string): boolean {
  const active = findActiveTurnByChat(id);
  if (!active) return false;
  return cancelActiveTurn(active.messageId, userId, id, 'user_cancelled');
}

describe('workspace trust', () => {
  it('refuses a Cursor turn against a workspace nobody has trusted', async () => {
    // Not a validation failure and not a conflict: the request is well-formed
    // and will stay refused until a person makes one decision.
    const cursorChatId = await insertExternalChat();
    await getDb()
      .updateTable('chats')
      .set({ runnerTargetId: 'cursor' })
      .where('id', '=', cursorChatId)
      .execute();
    const { stream } = harness({ agents: [descriptor({ targetId: 'cursor' })] });

    const result = await stream(
      {
        userId,
        chat: chatRecord({ runner: { kind: 'external', targetId: 'cursor' } }),
        chatId: cursorChatId,
        prompt: 'hello',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('workspace-trust');
    // The disclosure has to name what gets loaded, and only the machine running
    // the vendor can spell it. The vendor and machine travel with the path
    // because the grant is checked against this whole scope, not just the part
    // the dialog prints.
    expect(result.failure).toMatchObject({
      workspacePath: '/work/repo',
      targetId: 'cursor',
      environmentId: 'local',
    });
  });

  it('lets the same turn through once the workspace is trusted', async () => {
    const cursorChatId = await insertExternalChat();
    await getDb()
      .updateTable('chats')
      .set({ runnerTargetId: 'cursor' })
      .where('id', '=', cursorChatId)
      .execute();
    await grantWorkspaceTrust(
      { userId, targetId: 'cursor', environmentId: 'local', workspacePath: '/work/repo' },
      getDb()
    );
    const { stream, runtime } = harness({ agents: [descriptor({ targetId: 'cursor' })] });

    const result = await stream(
      {
        userId,
        chat: chatRecord({ runner: { kind: 'external', targetId: 'cursor' } }),
        chatId: cursorChatId,
        prompt: 'hello',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reading = readChunks(result.response);
    await waitForTurnStart(runtime);
    runtime.emit({ type: 'completed' });
    await reading;
    expect(runtime.calls.turn).toHaveLength(1);
  });

  it('never gates a vendor that has not declared what it loads', async () => {
    // The Codex chat above runs untouched: adding the gate must not re-prompt
    // every existing user of an adapter this disclosure says nothing about.
    const { stream } = harness();

    const result = await stream(
      {
        userId,
        chat: chatRecord(),
        chatId,
        prompt: 'hello',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );

    expect(result.ok).toBe(true);
  });
});
