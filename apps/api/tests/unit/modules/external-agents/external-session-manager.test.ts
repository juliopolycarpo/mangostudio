import { beforeEach, describe, expect, it } from 'bun:test';
import type { ExternalAgentConfiguration } from '@mangostudio/shared/external-agents';
import { getDb } from '../../../../src/db/database';
import {
  createExternalSessionManager,
  type EnsureExternalSessionInput,
  type ExternalSessionConsumer,
  ExternalSessionReapedError,
} from '../../../../src/modules/external-agents/application/external-session-manager';
import { readContinuation } from '../../../../src/modules/external-agents/infrastructure/external-session-continuation-repository';
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

function managerFor(runtime: FakeExternalRuntime, sessionIds: readonly string[] = []) {
  let index = 0;
  return createExternalSessionManager({
    resolveRuntimeClient: () => Promise.resolve(runtime.client),
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
