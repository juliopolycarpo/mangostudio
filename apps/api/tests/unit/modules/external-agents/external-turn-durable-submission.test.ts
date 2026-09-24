/**
 * Durable submission of an external turn, against a real `RuntimeClient`.
 *
 * Every case counts native submissions on the runtime side, separately from
 * the RPCs that reached it, so "the turn completed" can never hide a second
 * vendor turn behind it.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { ExternalAgentConfiguration } from '@mangostudio/shared/external-agents';
import type { ExternalTurnPart, MessagePart } from '@mangostudio/shared/types';
import { sql } from 'kysely';
import { getDb } from '../../../../src/db/database';
import { createExternalApprovalRegistry } from '../../../../src/modules/external-agents/application/external-approval-registry';
import { createExternalCommandCatalogCache } from '../../../../src/modules/external-agents/application/external-command-catalog-cache';
import {
  createExternalSessionManager,
  type ExternalSessionManager,
} from '../../../../src/modules/external-agents/application/external-session-manager';
import {
  createExternalTurnController,
  type ExternalTurnResult,
} from '../../../../src/modules/external-agents/application/external-turn-controller';
import { listAttemptsForMessage } from '../../../../src/modules/external-agents/infrastructure/external-turn-attempt-repository';
import { cancelActiveTurn } from '../../../../src/modules/generation/application/active-turn-registry';
import {
  createFakeBackoffClock,
  type FakeBackoffClock,
} from '../../../support/external-agents/fake-backoff-clock';
import {
  createReceiptKeepingRuntime,
  type ReceiptKeepingRuntime,
} from '../../../support/external-agents/receipt-keeping-runtime';
import { insertTestUser } from '../../../support/factories';

const CONFIGURATION: ExternalAgentConfiguration = {
  level: 'default',
  routing: 'user',
  workspaceRoots: ['/work/repo'],
};

let userId = '';
let chatId = '';
let assistantMessageId = '';
let userMessageId = '';

beforeEach(async () => {
  const user = await insertTestUser();
  userId = user.id;
  chatId = `chat-${crypto.randomUUID()}`;
  userMessageId = `user-${crypto.randomUUID()}`;
  assistantMessageId = `assistant-${crypto.randomUUID()}`;
  await getDb()
    .insertInto('chats')
    .values({
      id: chatId,
      title: 'external chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: null,
      userId,
      runnerKind: 'external',
      runnerTargetId: 'codex',
      workdir: '/work/repo',
      environmentId: 'local',
    })
    .execute();
});

/**
 * The session manager, except that the connection behind the first session
 * drops right after it opens and stays down: the next attempt has nothing to
 * write its request to until the runtime comes back.
 */
function droppingAfterOpen(
  sessions: ExternalSessionManager,
  runtime: ReceiptKeepingRuntime
): ExternalSessionManager {
  let dropped = false;
  return {
    ...sessions,
    async ensureSession(input) {
      const handle = await sessions.ensureSession(input);
      if (!dropped) {
        dropped = true;
        runtime.setAvailable(false);
        await runtime.drop();
      }
      return handle;
    },
  };
}

function harness(
  options: {
    readonly clock?: FakeBackoffClock;
    readonly callTimeoutMs?: number;
    readonly dropAfterOpen?: boolean;
    readonly terminalConnectFailure?: boolean;
  } = {}
) {
  const runtime = createReceiptKeepingRuntime();
  const clock = options.clock ?? createFakeBackoffClock({ auto: true });
  let sessionNumber = 0;
  const baseSessions = createExternalSessionManager({
    resolveRuntimeClient: () => runtime.resolveClient(),
    newSessionId: () => {
      sessionNumber += 1;
      return `session-${sessionNumber}`;
    },
    callTimeoutMs: options.callTimeoutMs ?? 10_000,
  });
  const sessions = options.dropAfterOpen ? droppingAfterOpen(baseSessions, runtime) : baseSessions;
  const ids = [userMessageId, assistantMessageId];
  const controller = createExternalTurnController({
    sessions,
    approvals: createExternalApprovalRegistry(),
    commandCatalog: createExternalCommandCatalogCache(),
    newId: () => ids.shift() ?? `attempt-${crypto.randomUUID()}`,
    sleep: clock.sleep,
    random: () => 0.5,
    isTerminalConnectFailure: () => options.terminalConnectFailure === true,
  });
  return { runtime, clock, sessions: baseSessions, controller };
}

function start(controller: ReturnType<typeof harness>['controller']): Promise<ExternalTurnResult> {
  return controller.start(
    {
      userId,
      chatId,
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
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`expected ${label} | received: still waiting after 2s`);
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

async function attemptStates(): Promise<string[]> {
  return (await listAttemptsForMessage(assistantMessageId, getDb())).map((row) => row.state);
}

async function turnPart(): Promise<{ part: ExternalTurnPart; generating: boolean }> {
  const row = await getDb()
    .selectFrom('messages')
    .select(['parts', 'isGenerating'])
    .where('id', '=', assistantMessageId)
    .executeTakeFirstOrThrow();
  const parts = JSON.parse(row.parts ?? '[]') as MessagePart[];
  const part = parts.find((entry): entry is ExternalTurnPart => entry.type === 'external_turn');
  if (!part) throw new Error('expected an external_turn part | received: none');
  return { part, generating: row.isGenerating === 1 };
}

describe('receipt before submission', () => {
  it('(a) sends nothing when the pre-submission receipt cannot be written', async () => {
    const { runtime, controller } = harness();
    await sql`CREATE TRIGGER refuse_attempts BEFORE INSERT ON external_turn_attempts BEGIN SELECT RAISE(ABORT, 'receipt refused'); END`.execute(
      getDb()
    );
    try {
      const running = start(controller);
      let result: ExternalTurnResult | undefined;
      void running.then((settled) => {
        result = settled;
      });
      await waitFor(
        () => result !== undefined || runtime.rpcCount() > 0,
        'the turn to end before any request reaches the runtime'
      );
      expect(runtime.rpcCount()).toBe(0);
      if (!result) throw new Error('expected a settled turn | received: still running');
      expect(result.reason).toBe('vendor-error');
      expect(result.error?.code).toBe('turn-receipt');
      expect({ rpcs: runtime.rpcCount(), submissions: runtime.submissionCount() }).toEqual({
        rpcs: 0,
        submissions: 0,
      });
    } finally {
      await sql`DROP TRIGGER IF EXISTS refuse_attempts`.execute(getDb());
      await runtime.close();
    }
  });

  it('records the attempt as acceptance-unknown before the runtime sees it', async () => {
    const { runtime, controller } = harness();
    runtime.script.push('stall');
    const running = start(controller);
    await waitFor(() => runtime.rpcCount() === 1, 'one turn request at the runtime');
    const rows = await listAttemptsForMessage(assistantMessageId, getDb());
    expect(rows.map((row) => row.state)).toEqual(['acceptance-unknown']);
    expect(rows[0]?.inputFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(rows[0]?.clientMessageId).toBe(userMessageId);
    runtime.releaseStalled();
    await settle();
    runtime.emit({ type: 'completed' });
    expect((await running).reason).toBe('completed');
    await runtime.close();
  });
});

describe('lost acknowledgements', () => {
  it('(b) reconciles a lost reply on the same connection with one submission', async () => {
    const { runtime, controller } = harness({ callTimeoutMs: 50 });
    runtime.script.push('stall');
    const running = start(controller);
    await waitFor(() => runtime.rpcCount() === 2, 'the resend of the unanswered turn');
    await settle();
    runtime.emit({ type: 'text_delta', text: 'done' });
    runtime.emit({ type: 'completed' });
    const result = await running;

    expect(result.reason).toBe('completed');
    expect(result.nativeTurnId).toBe('native-turn-1');
    expect({
      rpcs: runtime.rpcCount(),
      submissions: runtime.submissionCount(),
      connections: runtime.connectionCount(),
    }).toEqual({ rpcs: 2, submissions: 1, connections: 1 });
    expect(await attemptStates()).toEqual(['terminal']);
    await runtime.close();
  });

  it('(g) resends byte-identical params, so the committed result is reused', async () => {
    const { runtime, controller } = harness({ callTimeoutMs: 50 });
    runtime.script.push('stall');
    const running = start(controller);
    await waitFor(() => runtime.rpcCount() === 2, 'the resend of the unanswered turn');
    await settle();
    runtime.emit({ type: 'completed' });
    const result = await running;

    expect(JSON.stringify(runtime.turns[1])).toBe(JSON.stringify(runtime.turns[0]));
    expect(result.nativeTurnId).toBe('native-turn-1');
    expect(runtime.submissionCount()).toBe(1);
    const [row] = await listAttemptsForMessage(assistantMessageId, getDb());
    expect(row?.nativeTurnId).toBe('native-turn-1');
    await runtime.close();
  });

  it('(c) marks a lost reply across a dropped connection unresolved and never resends it', async () => {
    const { runtime, controller } = harness();
    runtime.script.push('drop-ack');
    const running = start(controller);
    let result: ExternalTurnResult | undefined;
    void running.then((settled) => {
      result = settled;
    });
    await waitFor(
      () => result !== undefined || runtime.submissionCount() > 1,
      'the turn to end without a second submission'
    );
    expect(runtime.submissionCount()).toBe(1);
    if (!result) throw new Error('expected a settled turn | received: still running');
    await settle();

    expect(result.reason).toBe('acceptance-unknown');
    expect(result.error?.code).toBe('acceptance-unknown');
    expect({
      rpcs: runtime.rpcCount(),
      submissions: runtime.submissionCount(),
      connections: runtime.connectionCount(),
    }).toEqual({ rpcs: 1, submissions: 1, connections: 1 });
    expect(await attemptStates()).toEqual(['unresolved']);
    const { part, generating } = await turnPart();
    expect(part.terminalReason).toBe('acceptance-unknown');
    expect(generating).toBe(false);
  });

  it('treats a runtime error reply as a committed refusal, not a retry', async () => {
    const { runtime, controller, clock } = harness();
    runtime.script.push('refuse');
    const result = await start(controller);

    expect(result.reason).toBe('vendor-error');
    expect(runtime.rpcCount()).toBe(1);
    expect(clock.waits).toEqual([]);
    expect(await attemptStates()).toEqual(['terminal']);
    await runtime.close();
  });
});

describe('never-written submissions', () => {
  it('(d) keeps retrying past five failed connects with capped backoff and submits once', async () => {
    const clock = createFakeBackoffClock({ auto: true });
    const { runtime, controller } = harness({ clock, dropAfterOpen: true });
    clock.onWait((count) => {
      if (count === 7) runtime.setAvailable(true);
    });
    const running = start(controller);
    await waitFor(() => runtime.rpcCount() === 1, 'the turn once the runtime is back');
    await settle();
    runtime.emit({ type: 'completed' });
    const result = await running;

    expect(result.reason).toBe('completed');
    expect(clock.waits.length).toBe(7);
    // Doubling from 1s, half-jittered at random() = 0.5, capped at 30s.
    expect(clock.waits).toEqual([750, 1_500, 3_000, 6_000, 12_000, 22_500, 22_500]);
    expect({
      rpcs: runtime.rpcCount(),
      submissions: runtime.submissionCount(),
      connections: runtime.connectionCount(),
    }).toEqual({ rpcs: 1, submissions: 1, connections: 2 });
    await runtime.close();
  });

  it('stops on a connect failure no wait can fix', async () => {
    const { runtime, controller } = harness({
      dropAfterOpen: true,
      terminalConnectFailure: true,
    });
    const result = await start(controller);
    expect(result.reason).toBe('vendor-error');
    expect(runtime.rpcCount()).toBe(0);
  });
});

describe('stopping', () => {
  async function waitingInBackoff() {
    const clock = createFakeBackoffClock({ auto: false });
    const context = harness({ clock, dropAfterOpen: true });
    const running = start(context.controller);
    await waitFor(() => clock.pendingCount() === 1, 'the turn to wait in backoff');
    return { ...context, running };
  }

  async function expectNoLaterSubmission(
    runtime: ReceiptKeepingRuntime,
    clock: FakeBackoffClock
  ): Promise<void> {
    runtime.setAvailable(true);
    clock.advance();
    await settle();
    expect({ rpcs: runtime.rpcCount(), connections: runtime.connectionCount() }).toEqual({
      rpcs: 0,
      connections: 1,
    });
  }

  it('(e) an abort during backoff ends the turn and every retry', async () => {
    const { runtime, clock, running } = await waitingInBackoff();
    expect(cancelActiveTurn(assistantMessageId, userId, chatId, 'user_cancelled')).toBe(true);
    expect((await running).reason).toBe('cancelled-by-user');
    await expectNoLaterSubmission(runtime, clock);
  });

  it('(e) a consent revocation during backoff ends every retry', async () => {
    const { runtime, clock, sessions, running } = await waitingInBackoff();
    await sessions.reapScope({ userId }, 'consent-revoked');
    expect((await running).reason).toBe('consent-revoked');
    await expectNoLaterSubmission(runtime, clock);
  });

  it('(e) hub shutdown during backoff ends every retry', async () => {
    const { runtime, clock, sessions, running } = await waitingInBackoff();
    await sessions.reapAll('hub-restarted');
    expect((await running).reason).toBe('hub-restarted');
    await expectNoLaterSubmission(runtime, clock);
  });

  it('(e) a reply arriving after an abort cannot revive the attempt', async () => {
    const { runtime, controller } = harness();
    runtime.script.push('stall');
    const running = start(controller);
    await waitFor(() => runtime.rpcCount() === 1, 'the stalled turn');
    cancelActiveTurn(assistantMessageId, userId, chatId, 'user_cancelled');
    expect((await running).reason).toBe('cancelled-by-user');

    runtime.releaseStalled();
    await waitFor(
      () => runtime.cancels.some((cancel) => cancel.nativeTurnId === 'native-turn-1'),
      'the late-accepted vendor turn to be cancelled'
    );
    await settle();
    expect(await attemptStates()).toEqual(['unresolved']);
    const { part, generating } = await turnPart();
    expect(part.terminalReason).toBe('cancelled-by-user');
    expect(generating).toBe(false);
    expect(runtime.submissionCount()).toBe(1);
    await runtime.close();
  });
});
