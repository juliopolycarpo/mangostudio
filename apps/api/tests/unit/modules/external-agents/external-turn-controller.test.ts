import { beforeEach, describe, expect, it } from 'bun:test';
import type {
  ExternalAgentConfiguration,
  ExternalAgentSteerResult,
} from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import type {
  ExternalApprovalPart,
  ExternalSteerPart,
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

function harness(
  options: FakeExternalRuntimeOptions & { readonly steerTerminationGraceMs?: number } = {}
) {
  const { steerTerminationGraceMs, ...runtimeOptions } = options;
  const runtime = createFakeExternalRuntime(runtimeOptions);
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
    ...(steerTerminationGraceMs !== undefined ? { steerTerminationGraceMs } : {}),
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

function steerPartOf(parts: readonly MessagePart[], clientMessageId: string): ExternalSteerPart {
  const part = parts.find(
    (entry): entry is ExternalSteerPart =>
      entry.type === 'external_steer' && entry.clientMessageId === clientMessageId
  );
  if (!part) throw new Error(`the transcript has no external_steer part for "${clientMessageId}"`);
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

  describe('native review', () => {
    const REVIEW_CAPABILITIES = {
      ...NO_EXTERNAL_AGENT_CAPABILITIES,
      structuredStreaming: true,
      cancellation: true,
      steering: true,
      nativeReview: true,
    };

    function startReview(
      controller: ReturnType<typeof harness>['controller']
    ): Promise<ExternalTurnResult> {
      return controller.start(
        {
          userId,
          chatId,
          prompt: 'Review my uncommitted changes.',
          configuration: CONFIGURATION,
          canonicalWorkspacePath: '/work/repo',
          vendorAccountFingerprint: 'account-a',
          credentialHomeFingerprint: 'sha256:home-a',
          review: { target: { type: 'uncommittedChanges' } },
        },
        getDb()
      );
    }

    it('runs the review as an ordinary turn, on the same session and transcript', async () => {
      const { runtime, controller } = harness({ capabilities: REVIEW_CAPABILITIES });
      const running = startReview(controller);
      await waitFor(
        () => runtime.calls.startReview.length === 1,
        'the review to reach the runtime'
      );

      // The review replaces the vendor call, not the orchestration: no
      // `external-agent.turn` is sent, and the prompt is a caption rather than
      // input the vendor was handed.
      expect(runtime.calls.turn).toHaveLength(0);
      expect(runtime.calls.startReview[0]).toMatchObject({
        sessionId: 'session-1',
        clientMessageId: userMessageId,
        target: { type: 'uncommittedChanges' },
      });

      runtime.emit({
        type: 'activity_started',
        callId: 'item-review-in',
        activity: { name: 'enteredReviewMode', kind: 'review', title: 'uncommitted changes' },
      });
      runtime.emit({ type: 'text_delta', text: 'P1: the retry loop never exits.' });
      runtime.emit({ type: 'completed' });

      const result = await running;
      expect(result.reason).toBe('completed');
      const stored = await readAssistantRow();
      expect(stored.text).toContain('P1: the retry loop never exits.');
      expect(turnPartOf(stored.parts)).toMatchObject({
        status: 'terminal',
        nativeTurnId: 'native-turn-1',
      });
    });

    it('refuses to steer a review, before anything durable is written', async () => {
      const { runtime, controller } = harness({ capabilities: REVIEW_CAPABILITIES });
      const running = startReview(controller);
      await waitFor(
        () => runtime.calls.startReview.length === 1,
        'the review to reach the runtime'
      );

      const outcome = await controller.steer({
        userId,
        chatId,
        clientMessageId: 'steer-1',
        text: 'also check the tests',
      });

      // The session supports steering in general; this turn does not, which is
      // exactly what `turn-not-steerable` is for.
      expect(outcome).toEqual({ accepted: false, reasonCode: 'turn-not-steerable' });
      expect(runtime.calls.steer).toHaveLength(0);
      const parts = (await readAssistantRow()).parts;
      expect(parts.some((part) => part.type === 'external_steer')).toBe(false);

      runtime.emit({ type: 'completed' });
      await running;
    });

    it('fails the turn when the vendor ran the review on another thread', async () => {
      // Inline delivery is documented to answer with the session's own thread.
      // A different one means the events are arriving somewhere the hub is not
      // listening, so the turn ends rather than appearing to run forever.
      const { runtime, controller } = harness({
        capabilities: REVIEW_CAPABILITIES,
        reviewThreadId: 'some-other-thread',
      });

      const result = await startReview(controller);
      expect(result.reason).toBe('vendor-error');
      expect(result.error?.code).toBe('review-start');
      expect(result.error?.message).toContain('some-other-thread');
      expect(runtime.calls.startReview).toHaveLength(1);
    });

    it('refuses a review on a session whose adapter reported no nativeReview', async () => {
      // The session's own answer, not the cached descriptor the caller
      // preflighted against: an old runtime paired with a new hub says here
      // what it can actually do.
      const { controller } = harness();

      await expect(startReview(controller)).rejects.toThrow(/cannot review the working tree/);
    });
  });

  describe('steer', () => {
    it('persists the steered text before the vendor call resolves', async () => {
      const held = Promise.withResolvers<ExternalAgentSteerResult>();
      const { runtime, controller } = harness({ steerResult: () => held.promise });
      const running = startTurn(controller);
      await waitForTurnStart(runtime);

      const steering = controller.steer({
        userId,
        chatId,
        clientMessageId: 'steer-1',
        text: 'actually use the existing helper',
      });
      await waitFor(() => runtime.calls.steer.length === 1, 'the steer to reach the runtime');

      // The vendor call is still open, but the durable record already exists —
      // a lost acknowledgement must not erase what the user said.
      const midFlight = steerPartOf((await readAssistantRow()).parts, 'steer-1');
      expect(midFlight).toMatchObject({
        text: 'actually use the existing helper',
        status: 'accepted',
      });

      held.resolve({ accepted: true });
      await expect(steering).resolves.toEqual({ accepted: true });

      runtime.emit({ type: 'completed' });
      await running;
    });

    it('holds a vendor event behind a steer that has not been reported yet', async () => {
      const held = Promise.withResolvers<ExternalAgentSteerResult>();
      const { runtime, controller } = harness({ steerResult: () => held.promise });
      const log: string[] = [];
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
            onEvent: (event) => void log.push(event.type),
            onSteer: (steer) => void log.push(`steer:${steer.status}`),
          },
        },
        getDb()
      );
      await waitForTurnStart(runtime);

      const steering = controller.steer({
        userId,
        chatId,
        clientMessageId: 'steer-1',
        text: 'switch approach',
      });
      await waitFor(() => runtime.calls.steer.length === 1, 'the steer to reach the runtime');

      // Durably recorded after the steer — `transcript.parts` already has the
      // steer ahead of it — but the steer's own outcome has not been reported
      // to the observer yet. A live listener must not see this before it.
      runtime.emit({ type: 'text_delta', text: 'still working' });
      expect(log).toEqual([]);

      held.resolve({ accepted: true });
      await steering;

      expect(log).toEqual(['steer:accepted', 'text_delta']);

      runtime.emit({ type: 'completed' });
      await running;
    });

    it('corrects the durable record in place when Codex refuses the turn', async () => {
      const { runtime, controller } = harness({
        steerResult: () => ({ accepted: false, reasonCode: 'turn-not-steerable' }),
      });
      const running = startTurn(controller);
      await waitForTurnStart(runtime);

      const result = await controller.steer({
        userId,
        chatId,
        clientMessageId: 'steer-1',
        text: 'switch to plan mode',
      });
      expect(result).toEqual({ accepted: false, reasonCode: 'turn-not-steerable' });

      const part = steerPartOf((await readAssistantRow()).parts, 'steer-1');
      expect(part).toMatchObject({
        text: 'switch to plan mode',
        status: 'rejected',
        reasonCode: 'turn-not-steerable',
      });

      runtime.emit({ type: 'completed' });
      await running;
    });

    it('shares an in-flight clientMessageId and calls the runtime once', async () => {
      const held = Promise.withResolvers<ExternalAgentSteerResult>();
      const { runtime, controller } = harness({ steerResult: () => held.promise });
      const running = startTurn(controller);
      await waitForTurnStart(runtime);

      const input = { userId, chatId, clientMessageId: 'steer-1', text: 'once' };
      const first = controller.steer(input);
      await waitFor(() => runtime.calls.steer.length === 1, 'the first steer to reach the runtime');
      const second = controller.steer(input);
      held.resolve({ accepted: true });

      expect(await first).toEqual({ accepted: true });
      expect(await second).toEqual({ accepted: true });
      expect(runtime.calls.steer).toHaveLength(1);

      runtime.emit({ type: 'completed' });
      await running;
    });

    it('refuses a reused clientMessageId whose text no longer matches', async () => {
      const { runtime, controller } = harness();
      const running = startTurn(controller);
      await waitForTurnStart(runtime);

      const first = await controller.steer({
        userId,
        chatId,
        clientMessageId: 'steer-1',
        text: 'first draft',
      });
      expect(first).toEqual({ accepted: true });

      const second = await controller.steer({
        userId,
        chatId,
        clientMessageId: 'steer-1',
        text: 'edited draft',
      });
      expect(second).toEqual({ accepted: false, reasonCode: 'id-reused' });

      // The edit never reached the runtime, and the durable record still
      // shows only the original text — the second call must not have
      // recorded a duplicate part for it either.
      expect(runtime.calls.steer).toHaveLength(1);
      const part = steerPartOf((await readAssistantRow()).parts, 'steer-1');
      expect(part).toMatchObject({ text: 'first draft', status: 'accepted' });

      runtime.emit({ type: 'completed' });
      await running;
    });

    it('reuses a failed attempt instead of recording and dispatching a second one', async () => {
      const { runtime, controller } = harness({
        steerFailure: () => new Error('runtime unreachable'),
      });
      const running = startTurn(controller);
      await waitForTurnStart(runtime);

      const input = { userId, chatId, clientMessageId: 'steer-1', text: 'once' };
      await expect(controller.steer(input)).rejects.toThrow('runtime unreachable');
      await expect(controller.steer(input)).rejects.toThrow('runtime unreachable');

      expect(runtime.calls.steer).toHaveLength(1);
      const parts = (await readAssistantRow()).parts.filter(
        (part) => part.type === 'external_steer' && part.clientMessageId === 'steer-1'
      );
      expect(parts).toHaveLength(1);

      runtime.emit({ type: 'completed' });
      await running;
    });

    it('persists a rejected steer before terminal finalization', async () => {
      const held = Promise.withResolvers<ExternalAgentSteerResult>();
      const { runtime, controller } = harness({ steerResult: () => held.promise });
      const running = startTurn(controller);
      await waitForTurnStart(runtime);

      const steering = controller.steer({
        userId,
        chatId,
        clientMessageId: 'steer-1',
        text: 'switch to plan mode',
      });
      await waitFor(() => runtime.calls.steer.length === 1, 'the steer to reach the runtime');
      runtime.emit({ type: 'completed' });
      held.resolve({ accepted: false, reasonCode: 'turn-not-steerable' });

      await expect(steering).resolves.toEqual({
        accepted: false,
        reasonCode: 'turn-not-steerable',
      });
      await running;
      expect(steerPartOf((await readAssistantRow()).parts, 'steer-1')).toMatchObject({
        status: 'rejected',
        reasonCode: 'turn-not-steerable',
      });
    });

    it('refuses with turn-already-completed when no turn is running', async () => {
      const { runtime, controller } = harness();

      const result = await controller.steer({
        userId,
        chatId,
        clientMessageId: 'steer-1',
        text: 'hello?',
      });

      expect(result).toEqual({ accepted: false, reasonCode: 'turn-already-completed' });
      expect(runtime.calls.steer).toHaveLength(0);
    });

    it('refuses a steer from a user who did not start the turn, indistinguishably from no turn', async () => {
      const { runtime, controller } = harness();
      const running = startTurn(controller);
      await waitForTurnStart(runtime);
      const other = await insertTestUser();

      const result = await controller.steer({
        userId: other.id,
        chatId,
        clientMessageId: 'steer-1',
        text: 'hijacked',
      });

      expect(result).toEqual({ accepted: false, reasonCode: 'turn-already-completed' });
      expect(runtime.calls.steer).toHaveLength(0);

      runtime.emit({ type: 'completed' });
      await running;
    });

    it('refuses to write after the turn has already ended', async () => {
      const { runtime, controller } = harness();
      const running = startTurn(controller);
      await waitForTurnStart(runtime);
      runtime.emit({ type: 'completed' });
      await running;
      const finishedParts = (await readAssistantRow()).parts;

      const result = await controller.steer({
        userId,
        chatId,
        clientMessageId: 'steer-1',
        text: 'too late',
      });

      expect(result).toEqual({ accepted: false, reasonCode: 'turn-already-completed' });
      expect(runtime.calls.steer).toHaveLength(0);
      expect((await readAssistantRow()).parts).toEqual(finishedParts);
    });

    it('refuses with not-supported when the session capabilities never claimed steering', async () => {
      const { runtime, controller } = harness({
        capabilities: {
          ...NO_EXTERNAL_AGENT_CAPABILITIES,
          structuredStreaming: true,
          interactiveApprovals: true,
          cancellation: true,
          resume: true,
        },
      });
      const running = startTurn(controller);
      await waitForTurnStart(runtime);

      const result = await controller.steer({
        userId,
        chatId,
        clientMessageId: 'steer-1',
        text: 'hello?',
      });

      expect(result).toEqual({ accepted: false, reasonCode: 'not-supported' });
      expect(runtime.calls.steer).toHaveLength(0);
      const part = steerPartOf((await readAssistantRow()).parts, 'steer-1');
      expect(part.status).toBe('rejected');

      runtime.emit({ type: 'completed' });
      await running;
    });

    it('maps a session the runtime no longer has to session-lost', async () => {
      const { runtime, controller } = harness({
        steerFailure: () => Object.assign(new Error('session gone'), { name: 'ToolArgumentError' }),
      });
      const running = startTurn(controller);
      await waitForTurnStart(runtime);

      const result = await controller.steer({
        userId,
        chatId,
        clientMessageId: 'steer-1',
        text: 'hello?',
      });

      expect(result).toEqual({ accepted: false, reasonCode: 'session-lost' });

      runtime.emit({ type: 'completed' });
      await running;
    });

    it('finalizes without waiting out a hung steer acknowledgement', async () => {
      const hung = new Promise<ExternalAgentSteerResult>(() => {
        // Never settles — a runtime acknowledgement the turn's terminal path
        // must not block on indefinitely.
      });
      const { runtime, controller } = harness({
        steerResult: () => hung,
        steerTerminationGraceMs: 20,
      });
      const running = startTurn(controller);
      await waitForTurnStart(runtime);

      const steering = controller.steer({
        userId,
        chatId,
        clientMessageId: 'steer-1',
        text: 'switch approach',
      });
      await waitFor(() => runtime.calls.steer.length === 1, 'the steer to reach the runtime');

      const startedAt = Date.now();
      runtime.emit({ type: 'completed' });
      const result = await running;

      expect(result.reason).toBe('completed');
      // Bounded by the grace period, not by the runtime call that never
      // answers — `steering` itself is left permanently unsettled by this test.
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      void steering;
    });
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
