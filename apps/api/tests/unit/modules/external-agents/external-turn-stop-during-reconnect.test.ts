/**
 * A Stop that lands while a submitting turn is waiting for a runtime
 * connection that is still being opened.
 *
 * The turn's first session dies with its connection, so the submission loop
 * asks for a new one with `existingConnectionOnly`. That parks it on the
 * connection manager's in-flight connect — a slow runtime start can hold it
 * there for many seconds. The user presses Stop meanwhile. When the connect
 * finally resolves, the ended turn must not cause a vendor session to be
 * opened on the runtime (each open spawns a vendor process there).
 */

import { beforeEach, describe, expect, it } from 'bun:test';

import type { ExternalAgentConfiguration } from '@mangostudio/shared/external-agents';

import { getDb } from '../../../../src/db/database';
import { createExternalApprovalRegistry } from '../../../../src/modules/external-agents/application/external-approval-registry';
import { createExternalCommandCatalogCache } from '../../../../src/modules/external-agents/application/external-command-catalog-cache';
import {
  createExternalSessionManager,
  type ExternalSessionManager,
} from '../../../../src/modules/external-agents/application/external-session-manager';
import { createExternalTurnController } from '../../../../src/modules/external-agents/application/external-turn-controller';
import type { SubmissionOutcome } from '../../../../src/modules/external-agents/application/external-turn-submission';
import { cancelActiveTurn } from '../../../../src/modules/generation/application/active-turn-registry';
import { RuntimeConnectionManager } from '../../../../src/services/runtime-client/runtime-connection-manager';
import { createFakeBackoffClock } from '../../../support/external-agents/fake-backoff-clock';
import {
  createGatedConnectRuntime,
  type GatedConnectRuntime,
} from '../../../support/external-agents/gated-connect-runtime';
import { insertTestUser } from '../../../support/factories';
import { waitUntil } from '../../../support/wait-until';

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
 * drops right after it opens: the turn's first submission finds no live
 * session and has to reacquire one.
 */
function droppingAfterFirstOpen(
  sessions: ExternalSessionManager,
  runtime: GatedConnectRuntime
): ExternalSessionManager {
  let dropped = false;
  return {
    ...sessions,
    async ensureSession(input) {
      const handle = await sessions.ensureSession(input);
      if (dropped) return handle;
      dropped = true;
      await runtime.drop();
      return handle;
    },
  };
}

function harness() {
  const runtime = createGatedConnectRuntime();
  const clock = createFakeBackoffClock({ auto: false });
  const manager = new RuntimeConnectionManager({
    resolveEnvironment: (owner, environmentId) =>
      Promise.resolve({
        id: environmentId,
        userId: owner,
        name: 'Test box',
        transportKind: 'http' as const,
        config: { baseUrl: 'http://127.0.0.1:1' },
        enabled: true,
      }),
    connectors: { http: runtime.connector },
    recordTransition: () => undefined,
  });
  let existingClientRequests = 0;
  let sessionNumber = 0;
  const sessions = createExternalSessionManager({
    resolveRuntimeClient: (owner, environmentId) => manager.getClient(owner, environmentId),
    resolveExistingRuntimeClient: (owner, environmentId) => {
      existingClientRequests += 1;
      return manager.getExistingClient(owner, environmentId);
    },
    newSessionId: () => {
      sessionNumber += 1;
      return `session-${sessionNumber}`;
    },
    callTimeoutMs: 10_000,
  });
  const ids = [userMessageId, assistantMessageId];
  const submissions: Promise<SubmissionOutcome>[] = [];
  const controller = createExternalTurnController({
    observeSubmission: (_messageId, outcome) => {
      submissions.push(outcome);
    },
    sessions: droppingAfterFirstOpen(sessions, runtime),
    approvals: createExternalApprovalRegistry(),
    commandCatalog: createExternalCommandCatalogCache(),
    newId: () => ids.shift() ?? `attempt-${crypto.randomUUID()}`,
    sleep: clock.sleep,
    random: () => 0.5,
    isTerminalConnectFailure: () => false,
  });
  const submission = async (): Promise<SubmissionOutcome> => {
    await waitUntil(() => submissions.length === 1, 'the submission loop to start');
    const outcome = submissions[0];
    if (outcome === undefined) throw new Error('expected a submission | received: none');
    return await outcome;
  };
  return {
    runtime,
    clock,
    manager,
    controller,
    submission,
    existingClientRequests: () => existingClientRequests,
  };
}

describe('stop while the submission waits on an in-flight connect', () => {
  it('opens no vendor session for the stopped turn when the connect resolves', async () => {
    const { runtime, clock, manager, controller, submission, existingClientRequests } = harness();
    const running = controller.start(
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

    try {
      // Nothing connected: the first reacquire is refused and the loop backs off.
      await waitUntil(() => clock.pendingCount() === 1, 'the turn to wait in backoff');
      expect(runtime.opened).toEqual(['session-1']);

      // Someone else starts reconnecting; the runtime is slow to come up.
      void manager.connect(userId, 'local', { force: true }).catch(() => undefined);
      await waitUntil(() => runtime.pendingConnectCount() === 1, 'the reconnect to be in flight');

      // The loop wakes and parks on the in-flight connect.
      clock.advance();
      await waitUntil(
        () => existingClientRequests() === 2,
        'the second reacquire to wait on the in-flight connect'
      );

      expect(cancelActiveTurn(assistantMessageId, userId, chatId, 'user_cancelled')).toBe(true);
      const result = await running;
      if (result.reason !== 'cancelled-by-user') {
        throw new Error(
          `expected turn end reason: cancelled-by-user | received: ${String(result.reason)}`
        );
      }
      const openedAtStop = runtime.opened.length;

      runtime.releaseConnect();
      const outcome = await submission();
      if (outcome.kind !== 'stopped') {
        throw new Error(`expected submission outcome: stopped | received: ${outcome.kind}`);
      }

      const openedAfterStop = runtime.opened.slice(openedAtStop);
      const leftOpen = openedAfterStop.filter((sessionId) => !runtime.closed.includes(sessionId));
      if (openedAfterStop.length !== 0) {
        throw new Error(
          `expected vendor sessions opened after stop: 0 | received: ${openedAfterStop.length} ` +
            `(${openedAfterStop.join(', ')}; still open on the runtime: ${leftOpen.length})`
        );
      }
    } finally {
      runtime.releaseConnect();
      await runtime.close();
    }
  });
});
