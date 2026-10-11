import { beforeEach, describe, expect, it } from 'bun:test';
import { RemoteError } from '@mangostudio/protocol';
import type { ToolchainSelection } from '@mangostudio/shared/environments';
import type { ExternalAgentConfiguration } from '@mangostudio/shared/external-agents';
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
    // 43 s for Codex at the SDK's default limits). The hub drops its record before it asks, and
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
    // The runtime finishes a close that takes up to 43 s after the hub stopped waiting, so what the
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
