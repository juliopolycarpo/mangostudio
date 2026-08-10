import { beforeEach, describe, expect, it } from 'bun:test';
import type { ExternalAgentConfiguration } from '@mangostudio/shared/external-agents';
import type {
  ExternalApprovalPart,
  ExternalTurnPart,
  MessagePart,
} from '@mangostudio/shared/types';
import { getDb } from '../../../../src/db/database';
import { createExternalApprovalRegistry } from '../../../../src/modules/external-agents/application/external-approval-registry';
import { createExternalSessionManager } from '../../../../src/modules/external-agents/application/external-session-manager';
import {
  createExternalTurnController,
  ExternalTurnConflictError,
  type ExternalTurnResult,
  ExternalTurnRunnerMismatchError,
  ExternalTurnWorkspaceMissingError,
} from '../../../../src/modules/external-agents/application/external-turn-controller';
import { readContinuation } from '../../../../src/modules/external-agents/infrastructure/external-session-continuation-repository';
import { cancelActiveTurn } from '../../../../src/modules/generation/application/active-turn-registry';
import {
  createFakeExternalRuntime,
  type FakeExternalRuntime,
  type FakeExternalRuntimeOptions,
} from '../../../support/external-agents/fake-external-runtime';
import { insertTestUser } from '../../../support/factories';

const CONFIGURATION: ExternalAgentConfiguration = {
  level: 'default',
  routing: 'user',
  workspaceRoots: ['/work/repo'],
};

let userId = '';
let chatId = '';
/** Minted per test: the in-memory database is shared across the whole file. */
let userMessageId = '';
let assistantMessageId = '';

async function insertChat(runnerKind: 'external' | 'mangostudio' = 'external'): Promise<string> {
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
      runnerKind,
      ...(runnerKind === 'external'
        ? { runnerTargetId: 'codex' }
        : { runnerAgentId: 'default' as const }),
      workdir: '/work/repo',
      environmentId: 'local',
    })
    .execute();
  return id;
}

function harness(options: FakeExternalRuntimeOptions = {}) {
  const runtime = createFakeExternalRuntime(options);
  const sessions = createExternalSessionManager({
    resolveRuntimeClient: () => Promise.resolve(runtime.client),
    newSessionId: () => 'session-1',
  });
  const approvals = createExternalApprovalRegistry();
  const ids = [userMessageId, assistantMessageId];
  const controller = createExternalTurnController({
    sessions,
    approvals,
    newId: () => ids.shift() ?? `id-${crypto.randomUUID()}`,
  });
  return { runtime, sessions, approvals, controller };
}

function startTurn(
  controller: ReturnType<typeof harness>['controller'],
  overrides: { readonly chatId?: string } = {}
): Promise<ExternalTurnResult> {
  return controller.start(
    {
      userId,
      chatId: overrides.chatId ?? chatId,
      prompt: 'refactor the parser',
      configuration: CONFIGURATION,
      canonicalWorkspacePath: '/work/repo',
      vendorAccountFingerprint: 'account-a',
      credentialHomeFingerprint: 'sha256:home-a',
    },
    getDb()
  );
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

async function readAssistantRow(): Promise<{
  text: string;
  parts: MessagePart[];
  generating: boolean;
}> {
  const row = await getDb()
    .selectFrom('messages')
    .select(['text', 'parts', 'isGenerating'])
    .where('id', '=', assistantMessageId)
    .executeTakeFirstOrThrow();
  return {
    text: row.text,
    parts: row.parts ? (JSON.parse(row.parts) as MessagePart[]) : [],
    generating: row.isGenerating === 1,
  };
}

function turnPartOf(parts: readonly MessagePart[]): ExternalTurnPart {
  const part = parts.find((entry): entry is ExternalTurnPart => entry.type === 'external_turn');
  if (!part) throw new Error('the transcript has no external_turn part');
  return part;
}

beforeEach(async () => {
  const user = await insertTestUser();
  userId = user.id;
  chatId = await insertChat();
  userMessageId = `user-message-${crypto.randomUUID()}`;
  assistantMessageId = `assistant-message-${crypto.randomUUID()}`;
});

describe('external turn controller', () => {
  it('runs a turn to completion and finalizes the assistant message', async () => {
    const { runtime, controller } = harness();
    const running = startTurn(controller);
    await waitForTurnStart(runtime);

    runtime.emit({ type: 'text_delta', text: 'done' });
    runtime.emit({ type: 'usage', usage: { inputTokens: 42 } });
    runtime.emit({ type: 'completed' });

    const result = await running;
    expect(result.reason).toBe('completed');
    expect(result.usage).toEqual({ inputTokens: 42 });

    const stored = await readAssistantRow();
    expect(stored.text).toBe('done');
    expect(stored.generating).toBe(false);
    expect(turnPartOf(stored.parts)).toMatchObject({
      status: 'terminal',
      terminalReason: 'completed',
      nativeTurnId: 'native-turn-1',
    });
  });

  it('leaves a readable prefix on disk while the turn is still running', async () => {
    const { runtime, controller } = harness();
    const running = startTurn(controller);
    await waitForTurnStart(runtime);

    runtime.emit({ type: 'text_delta', text: 'partial answer' });
    runtime.emit({
      type: 'activity_started',
      callId: 'call-1',
      activity: { name: 'shell', kind: 'command', title: 'ls' },
    });

    const midTurn = await waitForStoredText('partial answer');
    expect(midTurn.generating).toBe(true);
    expect(midTurn.parts.some((part) => part.type === 'external_activity')).toBe(true);

    runtime.emit({ type: 'completed' });
    await running;
  });

  it('applies a redelivered event exactly once', async () => {
    const { runtime, controller } = harness();
    const running = startTurn(controller);
    await waitForTurnStart(runtime);

    const sequence = runtime.nextSequence();
    const envelope = {
      sessionId: runtime.sessionId(),
      nativeTurnId: 'native-turn-1',
      sequence,
      emittedAtMs: sequence,
      event: { type: 'text_delta', text: 'once' },
    } as const;
    runtime.emitEnvelope(envelope);
    runtime.emitEnvelope(envelope);
    runtime.emit({ type: 'completed' });

    await running;
    expect((await readAssistantRow()).text).toBe('once');
  });

  it('terminates on a sequence gap and keeps the partial transcript', async () => {
    const { runtime, controller } = harness();
    const running = startTurn(controller);
    await waitForTurnStart(runtime);

    runtime.emit({ type: 'text_delta', text: 'kept' });
    runtime.emitEnvelope({
      sessionId: runtime.sessionId(),
      nativeTurnId: 'native-turn-1',
      sequence: runtime.nextSequence() + 5,
      emittedAtMs: 99,
      event: { type: 'text_delta', text: 'lost' },
    });

    const result = await running;
    expect(result.reason).toBe('sequence-gap');
    const stored = await readAssistantRow();
    expect(stored.text).toBe('kept');
    expect(stored.generating).toBe(false);
  });

  it('drops events a vendor emits after saying it was done', async () => {
    const { runtime, controller } = harness();
    const running = startTurn(controller);
    await waitForTurnStart(runtime);

    runtime.emit({ type: 'text_delta', text: 'final' });
    runtime.emit({ type: 'completed' });
    runtime.emit({ type: 'text_delta', text: ' and more' });

    await running;
    expect((await readAssistantRow()).text).toBe('final');
  });

  it('terminates with the vendor error, structure intact', async () => {
    const { runtime, controller } = harness();
    const running = startTurn(controller);
    await waitForTurnStart(runtime);

    runtime.emit({
      type: 'error',
      error: { code: 'adapter-stream', message: 'the process died', vendorCode: 'E_DEAD' },
    });

    const result = await running;
    expect(result.reason).toBe('vendor-error');
    expect(result.error).toMatchObject({ vendorCode: 'E_DEAD' });
    expect(turnPartOf((await readAssistantRow()).parts).error?.message).toBe('the process died');
  });

  it('terminates when the runtime connection drops', async () => {
    const { runtime, controller } = harness();
    const running = startTurn(controller);
    await waitForTurnStart(runtime);
    runtime.emit({ type: 'text_delta', text: 'half' });

    runtime.dropConnection();

    const result = await running;
    expect(result.reason).toBe('runtime-disconnected');
    expect((await readAssistantRow()).text).toBe('half');
  });

  it('terminates when consent is withdrawn mid-turn', async () => {
    const { runtime, controller, sessions } = harness();
    const running = startTurn(controller);
    await waitForTurnStart(runtime);

    await sessions.reapScope({ userId }, 'consent-revoked');

    expect((await running).reason).toBe('consent-revoked');
    expect(runtime.calls.close).toHaveLength(1);
  });

  it('cancels even when the vendor never acknowledges', async () => {
    const { runtime, controller } = harness();
    const running = startTurn(controller);
    await waitForTurnStart(runtime);

    expect(cancelActiveTurn(assistantMessageId, userId, chatId, 'user_cancelled')).toBe(true);

    const result = await running;
    expect(result.reason).toBe('cancelled-by-user');
    expect(runtime.calls.cancel).toEqual([
      { sessionId: 'session-1', nativeTurnId: 'native-turn-1' },
    ]);
  });

  it('rejects a second send with a typed conflict and never opens a second session', async () => {
    const { runtime, controller } = harness();
    const running = startTurn(controller);
    await waitForTurnStart(runtime);

    await expect(startTurn(controller)).rejects.toBeInstanceOf(ExternalTurnConflictError);
    expect(runtime.calls.open).toHaveLength(1);

    runtime.emit({ type: 'completed' });
    await running;
  });

  it('refuses to start without a workspace for the vendor to run in', async () => {
    const { runtime, controller } = harness();
    await getDb().updateTable('chats').set({ workdir: null }).where('id', '=', chatId).execute();

    await expect(startTurn(controller)).rejects.toBeInstanceOf(ExternalTurnWorkspaceMissingError);
    expect(runtime.calls.open).toHaveLength(0);
  });

  it('refuses to run an external turn on a MangoStudio chat', async () => {
    const { controller } = harness();
    const internalChatId = await insertChat('mangostudio');

    await expect(startTurn(controller, { chatId: internalChatId })).rejects.toBeInstanceOf(
      ExternalTurnRunnerMismatchError
    );
  });

  it('forwards an answered approval and records the decision', async () => {
    const { runtime, controller, approvals } = harness();
    const running = startTurn(controller);
    await waitForTurnStart(runtime);

    runtime.emit({
      type: 'approval_requested',
      request: {
        requestId: 'req-1',
        kind: 'command',
        title: 'Run the migration',
        options: [{ id: 'approve', isDestructive: false }],
        expiresAtMs: Date.now() + 60_000,
      },
    });
    await waitFor(() => approvals.pendingCount(chatId) === 1, 'the approval to reach the registry');

    await expect(
      controller.answerApproval({ userId, chatId, requestId: 'req-1', optionId: 'approve' })
    ).resolves.toMatchObject({ status: 'accepted' });
    expect(runtime.calls.respond).toEqual([
      {
        sessionId: 'session-1',
        nativeTurnId: 'native-turn-1',
        requestId: 'req-1',
        optionId: 'approve',
      },
    ]);

    runtime.emit({
      type: 'approval_resolved',
      requestId: 'req-1',
      decision: { optionId: 'approve', source: 'user' },
    });
    runtime.emit({ type: 'completed' });
    await running;

    const approval = (await readAssistantRow()).parts.find(
      (part): part is ExternalApprovalPart => part.type === 'external_approval'
    );
    expect(approval).toMatchObject({ decision: 'approve', decisionSource: 'user' });
  });

  it('marks an approval outstanding at the end of a turn as expired', async () => {
    const { runtime, controller, approvals } = harness();
    const running = startTurn(controller);
    await waitForTurnStart(runtime);

    runtime.emit({
      type: 'approval_requested',
      request: {
        requestId: 'req-1',
        kind: 'command',
        title: 'Run the migration',
        options: [{ id: 'approve', isDestructive: false }],
        expiresAtMs: Date.now() + 60_000,
      },
    });
    runtime.emit({ type: 'completed' });
    await running;

    expect(approvals.pendingCount(chatId)).toBe(0);
    const approval = (await readAssistantRow()).parts.find(
      (part): part is ExternalApprovalPart => part.type === 'external_approval'
    );
    expect(approval).toMatchObject({ decisionSource: 'expired' });
    expect(approval?.decision).toBeUndefined();
  });

  it('terminates when the runtime refuses the turn call', async () => {
    const { controller } = harness({
      turnFailure: () => Object.assign(new Error('session gone'), { name: 'ToolArgumentError' }),
    });

    const result = await startTurn(controller);
    expect(result.reason).toBe('session-lost');
    expect((await readAssistantRow()).generating).toBe(false);
  });

  it('cancels the vendor when the hub itself ends the turn', async () => {
    const { runtime, controller } = harness();
    const running = startTurn(controller);
    await waitForTurnStart(runtime);

    // A gap is the hub's own verdict: the vendor was never told to stop, and it
    // is still holding the session's active turn. `limit-exceeded` reaches the
    // same cancel through the same helper.
    runtime.emitEnvelope({
      sessionId: runtime.sessionId(),
      nativeTurnId: 'native-turn-1',
      sequence: runtime.nextSequence() + 5,
      emittedAtMs: 99,
      event: { type: 'text_delta', text: 'lost' },
    });

    expect((await running).reason).toBe('sequence-gap');
    await waitFor(() => runtime.calls.cancel.length === 1, 'the vendor to be cancelled');
    expect(runtime.calls.cancel).toEqual([
      { sessionId: 'session-1', nativeTurnId: 'native-turn-1' },
    ]);
  });

  it('evicts the session the runtime says it lost', async () => {
    const { runtime, controller, sessions } = harness({
      turnFailure: () => Object.assign(new Error('session gone'), { name: 'ToolArgumentError' }),
    });

    await startTurn(controller);

    // Left cached, the next send would be handed the same dead handle and fail
    // the same way instead of opening a session it can use.
    await waitFor(() => runtime.calls.close.length === 1, 'the dead session to be closed');
    expect(sessions.liveSessionCount()).toBe(0);
    await expect(readContinuation(chatId, getDb())).resolves.toBeUndefined();
  });

  it('records an accepted approval without waiting for the vendor to echo it', async () => {
    const { runtime, controller, approvals } = harness();
    const running = startTurn(controller);
    await waitForTurnStart(runtime);

    runtime.emit({
      type: 'approval_requested',
      request: {
        requestId: 'req-1',
        kind: 'command',
        title: 'Run the migration',
        options: [{ id: 'approve', isDestructive: false }],
        expiresAtMs: Date.now() + 60_000,
      },
    });
    await waitFor(() => approvals.pendingCount(chatId) === 1, 'the approval to reach the registry');
    await controller.answerApproval({ userId, chatId, requestId: 'req-1', optionId: 'approve' });

    // No `approval_resolved`: the echo is optional, and a transcript that
    // recorded this card as expired would contradict the authorization the
    // vendor was actually sent.
    runtime.emit({ type: 'completed' });
    await running;

    const approval = (await readAssistantRow()).parts.find(
      (part): part is ExternalApprovalPart => part.type === 'external_approval'
    );
    expect(approval).toMatchObject({ decision: 'approve', decisionSource: 'user' });
  });

  it('keeps the vendor session handle out of the observer feed', async () => {
    const { runtime, controller } = harness();
    const events: string[] = [];
    const sessionIds: string[] = [];
    const running = controller.start(
      {
        userId,
        chatId,
        prompt: 'refactor the parser',
        configuration: CONFIGURATION,
        canonicalWorkspacePath: '/work/repo',
        vendorAccountFingerprint: 'account-a',
        credentialHomeFingerprint: 'sha256:home-a',
        observer: {
          onSession: (session) => void sessionIds.push(session.sessionId),
          onEvent: (event) => void events.push(event.type),
        },
      },
      getDb()
    );
    await waitForTurnStart(runtime);

    runtime.emit({ type: 'session_started', sessionId: 'native-session-1', resumed: false });
    runtime.emit({ type: 'text_delta', text: 'hello' });
    runtime.emit({ type: 'completed' });
    await running;

    // The hub-minted id, and only that: `session_started` carries the vendor's
    // resumable handle, which no client may address.
    expect(sessionIds).toEqual(['session-1']);
    expect(events).toEqual(['text_delta', 'completed']);
  });
});

async function waitForStoredText(expected: string) {
  let stored = await readAssistantRow();
  for (let attempt = 0; attempt < 500 && !stored.text.includes(expected); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    stored = await readAssistantRow();
  }
  if (!stored.text.includes(expected)) throw new Error(`stored text never became "${expected}"`);
  return stored;
}
