import { beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { RemoteError } from '@mangostudio/protocol';
import type { ToolchainSelection } from '@mangostudio/shared/environments';
import type { ExternalAgentConfiguration } from '@mangostudio/shared/external-agents';
import { UpdateQueryBuilder } from 'kysely';

import { getDb } from '../../../../src/db/database';
import {
  createExternalSessionManager,
  type EnsureExternalSessionInput,
  type ExternalSessionConsumer,
  ExternalSessionReapedError,
  isUnconfirmedClose,
} from '../../../../src/modules/external-agents/application/external-session-manager';
import {
  acquireAdoptionLease,
  readAdoptionLease,
} from '../../../../src/modules/external-agents/infrastructure/external-session-adoption-lease-repository';
import {
  readContinuation,
  setContinuationUnresumable,
  writeContinuation,
} from '../../../../src/modules/external-agents/infrastructure/external-session-continuation-repository';
import { RuntimeRequestNoReplyError } from '../../../../src/services/runtime-client/request-not-sent';
import { ToolExecutionTimedOutError } from '../../../../src/services/tools/execution-timeout';
import {
  createFakeExternalRuntime,
  type FakeExternalRuntime,
} from '../../../support/external-agents/fake-external-runtime';
import { insertTestUser } from '../../../support/factories';

const CONFIGURATION: ExternalAgentConfiguration = {
  level: 'default',
  routing: 'user',
  workspaceRoots: ['/work/repo'],
};

let userId = '';
let chatId = '';

async function insertExternalChat(owner: string, id: string): Promise<void> {
  await getDb()
    .insertInto('chats')
    .values({
      id,
      title: 'external chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: null,
      userId: owner,
      runnerKind: 'external',
      runnerTargetId: 'codex',
      workdir: '/work/repo',
      environmentId: 'local',
    })
    .execute();
}

function baseInput(overrides: Partial<EnsureExternalSessionInput> = {}) {
  return {
    userId,
    chatId,
    environmentId: 'local',
    targetId: 'codex',
    canonicalWorkspacePath: '/work/repo',
    vendorAccountFingerprint: 'account-a',
    credentialHomeFingerprint: 'sha256:home-a',
    configuration: CONFIGURATION,
    ...overrides,
  } satisfies EnsureExternalSessionInput;
}

function managerFor(
  runtime: FakeExternalRuntime,
  sessionIds: readonly string[] = [],
  resolveToolchain?: (userId: string, environmentId: string) => Promise<ToolchainSelection>
) {
  let index = 0;
  return createExternalSessionManager({
    resolveRuntimeClient: () => Promise.resolve(runtime.client),
    ...(resolveToolchain && { resolveToolchain }),
    newSessionId: () => sessionIds[index++] ?? `session-${index}`,
    now: () => 1_000,
  });
}

/**
 * A continuation store whose writes to the unresumable mark fail, as a database that has gone
 * read-only would. Every other statement runs against the real database.
 */
function refuseContinuationWrites() {
  const original = UpdateQueryBuilder.prototype.execute;
  let refused = 0;
  const spy = spyOn(UpdateQueryBuilder.prototype, 'execute');
  spy.mockImplementation(function (this: UpdateQueryBuilder<never, never, never, never>) {
    if (this.compile().sql.startsWith('update "external_session_continuations"')) {
      refused += 1;
      return Promise.reject(new Error('attempt to write a readonly database'));
    }
    return original.call(this);
  } as typeof original);
  return { refused: () => refused, restore: () => spy.mockRestore() };
}

function recordingConsumer(): ExternalSessionConsumer & { readonly teardowns: string[] } {
  const teardowns: string[] = [];
  return {
    teardowns,
    onEnvelope() {
      // Ordering is covered by the sequencer's own tests.
    },
    onTeardown(reason) {
      teardowns.push(reason);
    },
  };
}

beforeEach(async () => {
  const user = await insertTestUser();
  userId = user.id;
  chatId = `chat-${crypto.randomUUID()}`;
  await insertExternalChat(userId, chatId);
});

function capacityRefusal(): RemoteError {
  return new RemoteError(
    'INTERNAL',
    'External-agent session capacity is 4; close a session first.',
    {
      kind: 'external_agent_capacity',
    }
  );
}

function retryingManager(runtime: FakeExternalRuntime, capacityRetryMs: number) {
  return createExternalSessionManager({
    resolveRuntimeClient: () => Promise.resolve(runtime.client),
    newSessionId: () => 'session-a',
    now: () => 1_000,
    capacityRetryMs,
    capacityRetryIntervalMs: 5,
  });
}

describe('isUnconfirmedClose', () => {
  it('is true only for a close the hub stopped waiting for', () => {
    const hubDeadline = new ToolExecutionTimedOutError('late', {
      cause: new RuntimeRequestNoReplyError(new RemoteError('TIMEOUT', 'late'), 'deadline'),
    });
    const connectionClosed = new RuntimeRequestNoReplyError(
      new RemoteError('UNAVAILABLE', 'closed'),
      'connection-closed'
    );
    const refused = new RemoteError('INTERNAL', 'cleanup failed');
    const received = [hubDeadline, connectionClosed, refused, 'x'].map(isUnconfirmedClose);
    expect(received).toEqual([true, false, false, false]);
  });
});

describe('opening against a runtime at its session cap', () => {
  it('retries the refusal until the slot frees, then opens', async () => {
    // A reap that stopped waiting for a slow runtime close is followed by an open: the runtime
    // frees the slot when its close ends, so the refusal is retried rather than failing the send.
    let refusals = 2;
    const runtime = createFakeExternalRuntime({
      openFailure: () => (refusals-- > 0 ? capacityRefusal() : undefined),
    });

    const handle = await retryingManager(runtime, 2_000).ensureSession(baseInput());

    expect({ opens: runtime.calls.open.length, session: handle.sessionId }).toEqual({
      opens: 3,
      session: 'session-a',
    });
  });

  it("gives up with the runtime's own refusal once the wait has passed", async () => {
    const runtime = createFakeExternalRuntime({ openFailure: () => capacityRefusal() });

    const attempt = retryingManager(runtime, 40).ensureSession(baseInput());

    await expect(attempt).rejects.toMatchObject({ details: { kind: 'external_agent_capacity' } });
    expect(runtime.calls.open.length).toBeGreaterThan(1);
  });

  it('does not retry any other refusal', async () => {
    const runtime = createFakeExternalRuntime({
      openFailure: () => new RemoteError('INTERNAL', 'not installed', { kind: 'tool_argument' }),
    });

    await expect(retryingManager(runtime, 2_000).ensureSession(baseInput())).rejects.toThrow(
      'not installed'
    );
    expect(runtime.calls.open).toHaveLength(1);
  });
});

describe('external session manager', () => {
  it('collapses concurrent sends into one vendor session and one continuation row', async () => {
    const runtime = createFakeExternalRuntime();
    const manager = managerFor(runtime);

    const [first, second] = await Promise.all([
      manager.ensureSession(baseInput()),
      manager.ensureSession(baseInput()),
    ]);

    expect(runtime.calls.open).toHaveLength(1);
    expect(first?.sessionId).toBe(second?.sessionId as string);
    await expect(readContinuation(chatId, getDb())).resolves.toMatchObject({
      chatId,
      runtimeSessionId: first?.sessionId,
      nativeSessionId: 'native-session-1',
    });
  });

  it('resolves the environment toolchain and forwards it on open', async () => {
    const runtime = createFakeExternalRuntime();
    const toolchain: ToolchainSelection = { node: '/opt/custom/node/bin/node', bun: 'auto' };
    const seen: Array<{ userId: string; environmentId: string }> = [];
    const manager = managerFor(runtime, [], (resolvedUserId, environmentId) => {
      seen.push({ userId: resolvedUserId, environmentId });
      return Promise.resolve(toolchain);
    });

    await manager.ensureSession(baseInput());

    expect(runtime.calls.open[0]).toMatchObject({ toolchain });
    expect(seen).toEqual([{ userId, environmentId: 'local' }]);
  });

  it('omits the toolchain when the peer does not advertise support for it', async () => {
    const runtime = createFakeExternalRuntime();
    (runtime.client.manifest.features as { toolchain?: boolean }).toolchain = undefined;
    const manager = managerFor(runtime, [], () =>
      Promise.resolve({ node: '/opt/custom/node/bin/node', bun: 'auto' })
    );

    await manager.ensureSession(baseInput());

    expect(runtime.calls.open[0]).not.toHaveProperty('toolchain');
  });

  it('reuses the live session for a later send with the same binding', async () => {
    const runtime = createFakeExternalRuntime();
    const manager = managerFor(runtime);

    await manager.ensureSession(baseInput());
    await manager.ensureSession(baseInput());

    expect(runtime.calls.open).toHaveLength(1);
  });

  it('resumes the stored native session after the hub forgot it', async () => {
    const first = createFakeExternalRuntime();
    await managerFor(first).ensureSession(baseInput());

    const second = createFakeExternalRuntime();
    const handle = await managerFor(second).ensureSession(baseInput());

    expect(second.calls.open[0]?.resumeRef).toBe('native-session-1');
    expect(handle.resumed).toBe(true);
  });

  it('resumes an adopted session strictly, and stops once the vendor confirms it', async () => {
    // The ordinary send wants a conversation rather than a failure when the
    // vendor forgot the session. Adoption is the opposite: the user named
    // *that* conversation, and a fallback would hand them an empty one.
    await writeContinuation(
      {
        chatId,
        userId,
        environmentId: 'local',
        targetId: 'codex',
        canonicalWorkspacePath: '/work/repo',
        vendorAccountFingerprint: 'account-a',
        credentialHomeFingerprint: 'sha256:home-a',
        runtimeSessionId: '',
        nativeSessionId: 'adopted-thread',
        effectiveConfiguration: null,
        updatedAt: 1,
        pendingAdoption: true,
      },
      getDb()
    );

    const runtime = createFakeExternalRuntime({ nativeSessionId: 'adopted-thread' });
    await managerFor(runtime).ensureSession(baseInput());

    expect(runtime.calls.open[0]).toMatchObject({
      resumeRef: 'adopted-thread',
      resumeMode: 'strict',
    });
    await expect(readContinuation(chatId, getDb())).resolves.toMatchObject({
      pendingAdoption: false,
    });

    // The next send is an ordinary turn again.
    const later = createFakeExternalRuntime({ nativeSessionId: 'adopted-thread' });
    await managerFor(later).ensureSession(baseInput());
    expect(later.calls.open[0]?.resumeMode).toBe('fallback');
  });

  it('releases the adoption lease when the continuation is dropped', async () => {
    await writeContinuation(
      {
        chatId,
        userId,
        environmentId: 'local',
        targetId: 'codex',
        canonicalWorkspacePath: '/work/repo',
        vendorAccountFingerprint: 'account-a',
        credentialHomeFingerprint: 'sha256:home-a',
        runtimeSessionId: '',
        nativeSessionId: 'adopted-thread',
        effectiveConfiguration: null,
        updatedAt: 1,
        pendingAdoption: true,
      },
      getDb()
    );
    const key = {
      environmentId: 'local',
      targetId: 'codex',
      nativeSessionId: 'adopted-thread',
    } as const;
    await acquireAdoptionLease(
      { ...key, userId, chatId, acquiredAt: 1, expiresAt: 10_000_000 },
      getDb()
    );

    const runtime = createFakeExternalRuntime({ nativeSessionId: 'adopted-thread' });
    const manager = managerFor(runtime);
    await manager.ensureSession(baseInput());
    await manager.reapChat(chatId, 'session-lost');

    // The lease protects a pointer. Keeping it once the pointer is gone would
    // make the vendor session unadoptable for nobody's benefit.
    await expect(readAdoptionLease(key, getDb())).resolves.toBeUndefined();
  });

  it('reports resumed: false when the vendor could not resume', async () => {
    const first = createFakeExternalRuntime();
    await managerFor(first).ensureSession(baseInput());

    const second = createFakeExternalRuntime({ resumeSucceeds: false });
    const handle = await managerFor(second).ensureSession(baseInput());

    expect(handle.resumed).toBe(false);
  });

  describe('the resume mode a reopen asks for', () => {
    it.each([
      ['claude', 'strict'],
      ['codex', 'fallback'],
      ['cursor', 'fallback'],
    ] as const)('asks %s for a %s resume', async (targetId, expected) => {
      const first = createFakeExternalRuntime({ refuseFallbackResume: targetId === 'claude' });
      await managerFor(first).ensureSession(baseInput({ targetId }));
      const second = createFakeExternalRuntime({ refuseFallbackResume: targetId === 'claude' });

      await managerFor(second).ensureSession(baseInput({ targetId }));

      const open = second.calls.open[0];
      expect(
        { resumeRef: open?.resumeRef, resumeMode: open?.resumeMode },
        `expected a ${targetId} reopen to resume native-session-1 in ${expected} mode`
      ).toEqual({ resumeRef: 'native-session-1', resumeMode: expected });
    });

    it('opens a Claude session whose runtime refuses fallback resume, without a reset notice', async () => {
      const first = createFakeExternalRuntime({ refuseFallbackResume: true });
      await managerFor(first).ensureSession(baseInput({ targetId: 'claude' }));
      const second = createFakeExternalRuntime({ refuseFallbackResume: true });

      const handle = await managerFor(second).ensureSession(baseInput({ targetId: 'claude' }));

      // Claude confirms a resume on its first turn, so `resumed: false` here means unconfirmed.
      expect({ resumed: handle.resumed, reset: handle.takeConversationReset() }).toEqual({
        resumed: false,
        reset: undefined,
      });
    });

    it('reports a conversation reset when the agent declines the resume on open', async () => {
      const first = createFakeExternalRuntime();
      await managerFor(first).ensureSession(baseInput());
      const second = createFakeExternalRuntime({ resumeSucceeds: false });

      const handle = await managerFor(second).ensureSession(baseInput());

      expect(
        { first: handle.takeConversationReset(), again: handle.takeConversationReset() },
        'expected conversationReset: unavailable once, then none'
      ).toEqual({ first: 'unavailable', again: undefined });
    });

    describe('a stored conversation marked unresumable', () => {
      async function markedConversation() {
        const first = createFakeExternalRuntime({ refuseFallbackResume: true });
        const firstHandle = await managerFor(first).ensureSession(
          baseInput({ targetId: 'claude' })
        );
        await setContinuationUnresumable(chatId, firstHandle.sessionId, true, getDb());
        return firstHandle;
      }

      it('opens a new conversation instead of resuming it, and says so once', async () => {
        await markedConversation();
        const second = createFakeExternalRuntime({ refuseFallbackResume: true });

        const handle = await managerFor(second).ensureSession(baseInput({ targetId: 'claude' }));

        expect(
          {
            resumeRef: second.calls.open[0]?.resumeRef,
            first: handle.takeConversationReset(),
            again: handle.takeConversationReset(),
          },
          'expected an open without a resume reference that reports nonresumable once'
        ).toEqual({ resumeRef: undefined, first: 'nonresumable', again: undefined });
      });

      it('writes the new conversation unmarked, so the open after it resumes', async () => {
        await markedConversation();
        const second = createFakeExternalRuntime({ refuseFallbackResume: true });
        const reopened = await managerFor(second).ensureSession(baseInput({ targetId: 'claude' }));

        const row = await readContinuation(chatId, getDb());
        const third = createFakeExternalRuntime({ refuseFallbackResume: true });
        await managerFor(third).ensureSession(baseInput({ targetId: 'claude' }));

        expect(
          {
            unresumable: row?.unresumable,
            runtimeSessionId: row?.runtimeSessionId,
            thirdResumeRef: third.calls.open[0]?.resumeRef,
          },
          'expected the new conversation to be stored unmarked and resumed by the next open'
        ).toEqual({
          unresumable: false,
          runtimeSessionId: reopened.sessionId,
          thirdResumeRef: row?.nativeSessionId,
        });
      });

      it('is not resumed when the mark could not be written, until a write lands', async () => {
        const first = createFakeExternalRuntime({ refuseFallbackResume: true });
        const manager = managerFor(first);
        const handle = await manager.ensureSession(baseInput({ targetId: 'claude' }));
        const store = refuseContinuationWrites();
        try {
          await expect(
            handle.setConversationUnresumable(true),
            'expected a refused mark write to be absorbed, not thrown'
          ).resolves.toBeUndefined();
        } finally {
          store.restore();
        }
        const stored = await readContinuation(chatId, getDb());
        await handle.retire();

        const reopened = await manager.ensureSession(baseInput({ targetId: 'claude' }));

        expect(
          {
            writes: store.refused(),
            storedMark: stored?.unresumable,
            resumeRef: first.calls.open[1]?.resumeRef,
            reset: reopened.takeConversationReset(),
          },
          'expected the mark to be refused once, the row unmarked, and the next open fresh'
        ).toEqual({ writes: 1, storedMark: false, resumeRef: undefined, reset: 'nonresumable' });
      });

      it('is not marked by the end of a turn on a session an open has since replaced', async () => {
        const first = await markedConversation();
        const second = createFakeExternalRuntime({ refuseFallbackResume: true });
        await managerFor(second, ['session-replacing']).ensureSession(
          baseInput({ targetId: 'claude' })
        );

        const changed = await setContinuationUnresumable(chatId, first.sessionId, true, getDb());

        expect(
          { changed, unresumable: (await readContinuation(chatId, getDb()))?.unresumable },
          'expected a stale session id to leave the newer conversation unmarked'
        ).toEqual({ changed: false, unresumable: false });
      });
    });

    it('reports no reset for a first open', async () => {
      const handle = await managerFor(
        createFakeExternalRuntime({ resumeSucceeds: false })
      ).ensureSession(baseInput());
      expect(handle.takeConversationReset()).toBeUndefined();
    });
  });

  it.each([
    ['environment', { environmentId: 'remote' }],
    ['workspace', { canonicalWorkspacePath: '/work/other' }],
    ['vendor account', { vendorAccountFingerprint: 'account-b' }],
    ['credential home', { credentialHomeFingerprint: 'sha256:home-b' }],
    ['owning user', { userId: 'someone-else' }],
  ])('invalidates the continuation when the %s changes', async (_label, change) => {
    const first = createFakeExternalRuntime();
    await managerFor(first).ensureSession(baseInput());

    const second = createFakeExternalRuntime();
    const handle = await managerFor(second).ensureSession(
      baseInput(change as Partial<EnsureExternalSessionInput>)
    );

    expect(second.calls.open[0]?.resumeRef).toBeUndefined();
    expect(handle.resumed).toBe(false);
  });

  it.each([
    ['permission level', { level: 'full-access' as const }],
    ['approval routing', { routing: 'auto-review' as const }],
  ])('keeps the continuation when the %s changes', async (_label, change) => {
    const first = createFakeExternalRuntime();
    await managerFor(first).ensureSession(baseInput());

    const second = createFakeExternalRuntime();
    const handle = await managerFor(second).ensureSession(
      baseInput({ configuration: { ...CONFIGURATION, ...change } })
    );

    expect(second.calls.open[0]?.resumeRef).toBe('native-session-1');
    expect(handle.resumed).toBe(true);
  });

  it('closes a live session whose binding changed under it', async () => {
    const runtime = createFakeExternalRuntime();
    const manager = managerFor(runtime, ['session-a', 'session-b']);
    const handle = await manager.ensureSession(baseInput());
    const consumer = recordingConsumer();
    handle.subscribe(consumer);

    await manager.ensureSession(baseInput({ canonicalWorkspacePath: '/work/other' }));

    expect(consumer.teardowns).toEqual(['session-lost']);
    expect(runtime.calls.close).toEqual([{ sessionId: 'session-a' }]);
  });

  it('does not fail the reap, or keep the session counted, when the runtime close outlasts the hub wait', async () => {
    // The runtime's own close can legitimately take longer than the hub waits for it (up to
    // 38 s for Codex at the SDK's default limits). The hub drops its record before it asks, and
    // a timed-out ask abandons only the wait: the runtime finishes the close and frees its own slot.
    const runtime = createFakeExternalRuntime({
      closeFailure: () => new Error('Request "external-agent.close" timed out after 10000 ms'),
    });
    const manager = managerFor(runtime, ['session-a']);
    const handle = await manager.ensureSession(baseInput());
    const consumer = recordingConsumer();
    handle.subscribe(consumer);

    await manager.reapChat(chatId, 'session-lost');

    expect({
      closeAsked: runtime.calls.close,
      teardowns: consumer.teardowns,
      counted: manager.liveSessionCount(),
    }).toEqual({
      closeAsked: [{ sessionId: 'session-a' }],
      teardowns: ['session-lost'],
      counted: 0,
    });
  });

  it('waits a bounded, shorter time for the runtime close than the runtime may take, and a shorter one still at shutdown', async () => {
    // The runtime finishes a close that takes up to 38 s after the hub stopped waiting, so what the
    // hub waits only decides how long a send, a chat update or a stop is held. The stop has 12 s in all.
    const runtime = createFakeExternalRuntime();
    const manager = managerFor(runtime, ['session-a', 'session-b']);
    await manager.ensureSession(baseInput());
    await manager.reapChat(chatId, 'session-lost');
    await manager.ensureSession(baseInput());
    await manager.reapAll('hub-restarted');

    expect(runtime.calls.closeTimeoutMs).toEqual([10_000, 5_000]);
  });

  it('tells the live turn when the runtime connection drops, and keeps the continuation', async () => {
    const runtime = createFakeExternalRuntime();
    const manager = managerFor(runtime);
    const handle = await manager.ensureSession(baseInput());
    const consumer = recordingConsumer();
    handle.subscribe(consumer);

    runtime.dropConnection();
    await Promise.resolve();

    expect(consumer.teardowns).toEqual(['runtime-disconnected']);
    await expect(readContinuation(chatId, getDb())).resolves.toBeDefined();
    expect(manager.liveSessionCount()).toBe(0);
  });

  describe('retire', () => {
    it('forgets the session and keeps the continuation, without telling a hold the chat ended', async () => {
      const runtime = createFakeExternalRuntime();
      const manager = managerFor(runtime);
      const handle = await manager.ensureSession(baseInput());
      const holdNotices: string[] = [];
      manager.holdChat({ chatId, userId, environmentId: 'local', targetId: 'codex' }, (reason) =>
        holdNotices.push(reason)
      );

      await handle.retire();

      expect({
        live: handle.isLive(),
        sessions: manager.liveSessionCount(),
        closes: runtime.calls.close.length,
        holdNotices,
        continuation: (await readContinuation(chatId, getDb()))?.nativeSessionId,
      }).toEqual({
        live: false,
        sessions: 0,
        closes: 1,
        holdNotices: [],
        continuation: 'native-session-1',
      });
    });

    it('drops the continuation when asked, so the next open starts a new conversation', async () => {
      const runtime = createFakeExternalRuntime();
      const manager = managerFor(runtime);
      const handle = await manager.ensureSession(baseInput());

      await handle.retire({ dropContinuation: true });
      await manager.ensureSession(baseInput());

      expect({
        continuationAfterRetire: runtime.calls.open[1]?.resumeRef,
      }).toEqual({ continuationAfterRetire: undefined });
    });

    it('does nothing for a session the chat no longer holds', async () => {
      const runtime = createFakeExternalRuntime();
      const manager = managerFor(runtime);
      const stale = await manager.ensureSession(baseInput());
      await stale.retire();
      const current = await manager.ensureSession(baseInput());

      await stale.retire();

      expect({
        currentLive: current.isLive(),
        closes: runtime.calls.close.length,
      }).toEqual({ currentLive: true, closes: 1 });
    });
  });

  it('drops the continuation when consent is withdrawn', async () => {
    const runtime = createFakeExternalRuntime();
    const manager = managerFor(runtime);
    const handle = await manager.ensureSession(baseInput());
    const consumer = recordingConsumer();
    handle.subscribe(consumer);

    await manager.reapScope({ userId }, 'consent-revoked');

    expect(consumer.teardowns).toEqual(['consent-revoked']);
    expect(runtime.calls.close).toHaveLength(1);
    await expect(readContinuation(chatId, getDb())).resolves.toBeUndefined();
  });

  it('keeps the continuation when the hub shuts down', async () => {
    const runtime = createFakeExternalRuntime();
    const manager = managerFor(runtime);
    const handle = await manager.ensureSession(baseInput());
    const consumer = recordingConsumer();
    handle.subscribe(consumer);

    await manager.reapAll('hub-restarted');

    expect(consumer.teardowns).toEqual(['hub-restarted']);
    expect(runtime.calls.close).toHaveLength(1);
    await expect(readContinuation(chatId, getDb())).resolves.toBeDefined();
  });

  it('closes a session that was reaped while the vendor was starting', async () => {
    // eslint-disable-next-line prefer-const -- This binding is assigned after a callback closes over it.
    let manager: ReturnType<typeof managerFor> | undefined;
    const runtime = createFakeExternalRuntime({
      // Stands in for a consent revocation or a chat deletion landing while the
      // vendor process is still coming up.
      onOpen: () => void manager?.reapChat(chatId, 'consent-revoked'),
    });
    manager = managerFor(runtime, ['session-a']);

    await expect(manager.ensureSession(baseInput())).rejects.toBeInstanceOf(
      ExternalSessionReapedError
    );
    expect(runtime.calls.close).toEqual([{ sessionId: 'session-a' }]);
    expect(manager.liveSessionCount()).toBe(0);
  });

  it('closes a session still opening when its scope is revoked', async () => {
    // eslint-disable-next-line prefer-const -- This binding is assigned after a callback closes over it.
    let manager: ReturnType<typeof managerFor> | undefined;
    const runtime = createFakeExternalRuntime({
      // A scoped revocation only sees established sessions; this chat exists
      // only in the single-flight until its slow open returns, and skipping it
      // would register a vendor process the owner has already refused.
      onOpen: () => void manager?.reapScope({ userId }, 'consent-revoked'),
    });
    manager = managerFor(runtime, ['session-a']);

    await expect(manager.ensureSession(baseInput())).rejects.toBeInstanceOf(
      ExternalSessionReapedError
    );
    expect(runtime.calls.close).toEqual([{ sessionId: 'session-a' }]);
    expect(manager.liveSessionCount()).toBe(0);
    await expect(readContinuation(chatId, getDb())).resolves.toBeUndefined();
  });

  it('never sends a MangoStudio tool definition or environment to the vendor', async () => {
    const runtime = createFakeExternalRuntime();
    const manager = managerFor(runtime);
    const handle = await manager.ensureSession(baseInput());
    await handle.startTurn({
      clientMessageId: 'msg-1',
      input: 'hello',
      configuration: CONFIGURATION,
    });

    const serialized = JSON.stringify([runtime.calls.open, runtime.calls.turn]);
    expect(serialized).not.toContain('tools');
    expect(serialized).not.toContain('env');
    expect(Object.keys(runtime.calls.turn[0] ?? {}).sort()).toEqual([
      'clientMessageId',
      'configuration',
      'input',
      'sessionId',
    ]);
  });
});
