import { describe, expect, it } from 'bun:test';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  ExternalAgentEvent,
  ExternalAgentRuntimeDescriptor,
  ExternalAgentTargetId,
} from '@mangostudio/shared/external-agents';
import {
  EXTERNAL_TEXT_LIMITS,
  EXTERNAL_TURN_PAYLOAD_MAX_BYTES,
} from '@mangostudio/shared/external-agents';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import type { RuntimeEventInput } from '../../../src/host';
import { createLocalRuntimeManifest } from '../../../src/manifest';
import type { ExternalAgentAdapter } from '../../../src/services/external-agents/adapter';
import { ExternalAgentAdapterRegistry } from '../../../src/services/external-agents/registry';
import { ExternalAgentSessionSupervisor } from '../../../src/services/external-agents/supervisor';
import type { SpawnEnvFs } from '../../../src/services/spawn-env';
import { FakeExternalAgentAdapter } from '../../support/fake-external-agent-adapter';

const CONFIGURATION = {
  level: 'default' as const,
  routing: 'user' as const,
  workspaceRoots: [] as readonly string[],
};

/** A second registered target whose discovery never settles. */
class HangingExternalAgentAdapter implements ExternalAgentAdapter {
  constructor(readonly targetId: ExternalAgentTargetId) {}
  discover(): Promise<ExternalAgentRuntimeDescriptor> {
    return new Promise<never>(() => undefined);
  }
  openSession(): never {
    throw new Error('This adapter only exists to hang discovery.');
  }
  startTurn(): never {
    throw new Error('This adapter only exists to hang discovery.');
  }
  respond(): never {
    throw new Error('This adapter only exists to hang discovery.');
  }
  cancel(): never {
    throw new Error('This adapter only exists to hang discovery.');
  }
  close(): never {
    throw new Error('This adapter only exists to hang discovery.');
  }
}

async function fixture(
  options: {
    readonly adapter?: FakeExternalAgentAdapter;
    readonly sessionCap?: number;
    readonly idleTimeoutMs?: number;
    readonly hardTurnTimeoutMs?: number;
    readonly cleanupTimeoutMs?: number;
    readonly consent?: {
      readonly current: () => typeof RUNTIME_CONSENT_PRESETS.full;
      readonly refresh: () => Promise<typeof RUNTIME_CONSENT_PRESETS.full>;
    };
    readonly authorizeWorkspace?: (path: string, signal: AbortSignal) => boolean | Promise<boolean>;
    readonly omitWorkspaceAuthorization?: boolean;
    readonly resolveExecutable?: () => Promise<{ readonly path?: string }>;
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: string;
    readonly homeDir?: string;
    readonly spawnEnvFs?: SpawnEnvFs;
  } = {}
) {
  const adapter = options.adapter ?? new FakeExternalAgentAdapter();
  const registry = new ExternalAgentAdapterRegistry([adapter]);
  const events: RuntimeEventInput[] = [];
  const workspacePath = await realpath(import.meta.dir);
  const consent = options.consent ?? {
    current: () => RUNTIME_CONSENT_PRESETS.full,
    refresh: async () => RUNTIME_CONSENT_PRESETS.full,
  };
  const supervisor = new ExternalAgentSessionSupervisor({
    registry,
    runtimeVersion: 'test',
    emit: (event) => events.push(event),
    consent: { slot: 'host', ...consent },
    env: options.env,
    ...(options.platform !== undefined && { platform: options.platform }),
    ...(options.homeDir !== undefined && { homeDir: options.homeDir }),
    ...(options.spawnEnvFs !== undefined && { spawnEnvFs: options.spawnEnvFs }),
    resolveExecutable: options.resolveExecutable ?? (async () => ({ path: process.execPath })),
    consentPollMs: 5,
    ...(!options.omitWorkspaceAuthorization
      ? { authorizeWorkspace: options.authorizeWorkspace ?? (() => true) }
      : {}),
    ...(options.sessionCap ? { sessionCap: options.sessionCap } : {}),
    ...(options.idleTimeoutMs ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    ...(options.hardTurnTimeoutMs ? { hardTurnTimeoutMs: options.hardTurnTimeoutMs } : {}),
    ...(options.cleanupTimeoutMs ? { cleanupTimeoutMs: options.cleanupTimeoutMs } : {}),
  });
  return { adapter, registry, events, supervisor, workspacePath };
}

async function openSession(
  value: Awaited<ReturnType<typeof fixture>>,
  sessionId = 'session-1',
  timeoutMs = 1_000,
  requestSignal: AbortSignal = new AbortController().signal
) {
  return await value.supervisor.open(
    {
      sessionId,
      targetId: 'codex',
      workspacePath: value.workspacePath,
      configuration: CONFIGURATION,
      resumeMode: 'fallback',
      timeoutMs,
    },
    requestSignal
  );
}

describe('external-agent adapter registry and supervisor', () => {
  it('derives the manifest target list and omits an empty registry', () => {
    const adapter = new FakeExternalAgentAdapter();
    const populated = new ExternalAgentAdapterRegistry([adapter]);

    expect(
      createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.full, {
        targetIds: populated.targetIds,
      }).externalAgents
    ).toEqual(['codex']);
    expect(
      createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.full, {
        targetIds: new ExternalAgentAdapterRegistry().targetIds,
      }).externalAgents
    ).toBeUndefined();
  });

  it('names the failing field when a method payload does not match its schema', async () => {
    // Every external-agent method opens with a schema check whose refusal is
    // rendered from the first error as `at "${path || '/'}"`. That pointer is
    // what a hub operator reading a `RuntimeToolArgumentError` has to work
    // from, so it is asserted as the rendered message rather than through the
    // error iterator the renderer happens to read.
    const value = await fixture();

    try {
      await expect(
        value.supervisor.discover({ targetIds: [], timeoutMs: 1_000 }, new AbortController().signal)
      ).rejects.toThrow(/invalid external-agent payload at "\/targetIds"/);
      await expect(
        value.supervisor.discover(
          { targetIds: ['codex'], timeoutMs: 0 },
          new AbortController().signal
        )
      ).rejects.toThrow(/invalid external-agent payload at "\/timeoutMs"/);
      await expect(
        value.supervisor.discover(undefined as never, new AbortController().signal)
      ).rejects.toThrow(/invalid external-agent payload at "\/"/);
    } finally {
      await value.supervisor.close();
    }
  });

  it('rejects optional capability drift during discovery', async () => {
    const adapter = new FakeExternalAgentAdapter({ capabilities: { steering: true } });
    const value = await fixture({ adapter });

    await expect(
      value.supervisor.discover(
        { targetIds: ['codex'], timeoutMs: 1_000 },
        new AbortController().signal
      )
    ).rejects.toThrow(/steer is missing/);
    await value.supervisor.close();
  });

  it('accepts an implemented capability the machine cannot serve', async () => {
    // Method presence is fixed per adapter class; capabilities are discovered
    // per machine. An adapter that can steer must still be able to report a CLI
    // build that cannot.
    const adapter = new FakeExternalAgentAdapter({
      steerable: true,
      capabilities: { steering: false },
    });
    const value = await fixture({ adapter });

    const result = await value.supervisor.discover(
      { targetIds: ['codex'], timeoutMs: 1_000 },
      new AbortController().signal
    );

    expect(result.descriptors[0]?.capabilities.steering).toBe(false);
    await value.supervisor.close();
  });

  it('authorizes a canonical workspace before resolving or opening an executable', async () => {
    const value = await fixture({ authorizeWorkspace: () => false });

    await expect(openSession(value)).rejects.toThrow(/not authorized/);
    expect(value.adapter.opens).toHaveLength(0);
    await value.supervisor.close();
  });

  it('default-denies workspace launch when no authorization policy is supplied', async () => {
    const value = await fixture({ omitWorkspaceAuthorization: true });

    await expect(openSession(value)).rejects.toThrow(/not authorized/);
    expect(value.adapter.opens).toHaveLength(0);
    await value.supervisor.close();
  });

  it('refuses a turn workspace root the open call never authorized', async () => {
    const value = await fixture();
    const otherRoot = await realpath(resolve(import.meta.dir, '..'));
    await value.supervisor.open(
      {
        sessionId: 'session-1',
        targetId: 'codex',
        workspacePath: value.workspacePath,
        configuration: { ...CONFIGURATION, workspaceRoots: [value.workspacePath] },
        resumeMode: 'fallback',
        timeoutMs: 1_000,
      },
      new AbortController().signal
    );

    // The owner's policy would allow this directory, but this session never
    // did. Turn configuration reaches the vendor verbatim as its sandbox
    // roots, so `open` is the only place a root can be authorized.
    expect(() =>
      value.supervisor.turn({
        sessionId: 'session-1',
        clientMessageId: 'message-1',
        input: 'widen',
        configuration: { ...CONFIGURATION, workspaceRoots: [otherRoot] },
      })
    ).toThrow(/was not authorized/);
    expect(value.adapter.turns).toHaveLength(0);

    // Narrowing stays inside the authorized set, so it is still allowed.
    await expect(
      value.supervisor.turn({
        sessionId: 'session-1',
        clientMessageId: 'message-1',
        input: 'narrow',
        configuration: CONFIGURATION,
      })
    ).resolves.toEqual({ nativeTurnId: 'turn-1' });
    await value.supervisor.close();
  });

  it('bounds discovery when the executable lookup never settles', async () => {
    // `probeAgentClis` takes no signal, so the deadline has to be raced around
    // the lookup rather than trusted to reach inside it.
    const value = await fixture({ resolveExecutable: () => new Promise<never>(() => undefined) });

    await expect(
      value.supervisor.discover(
        { targetIds: ['codex'], timeoutMs: 10 },
        new AbortController().signal
      )
    ).rejects.toThrow(/Deadline exceeded/);
    await value.supervisor.close();
  });

  it('keeps a healthy target when a sibling target never answers discovery', async () => {
    // `timeoutMs` is a per-target budget, so one vendor's slow handshake must
    // cost only its own descriptor. Rejecting the batch would hand the hub
    // nothing, and the hub cannot tell that apart from a runtime that said
    // nothing at all -- so it would degrade every healthy target to the
    // capability-free cheap scan and hide their model and permission pickers.
    const registry = new ExternalAgentAdapterRegistry([
      new FakeExternalAgentAdapter(),
      new HangingExternalAgentAdapter('cursor'),
    ]);
    const supervisor = new ExternalAgentSessionSupervisor({
      registry,
      runtimeVersion: 'test',
      emit: () => undefined,
      consent: {
        slot: 'host',
        current: () => RUNTIME_CONSENT_PRESETS.full,
        refresh: async () => RUNTIME_CONSENT_PRESETS.full,
      },
      resolveExecutable: async () => ({ path: process.execPath }),
      consentPollMs: 5,
      authorizeWorkspace: () => true,
    });

    const result = await supervisor.discover(
      { targetIds: ['codex', 'cursor'], timeoutMs: 50 },
      new AbortController().signal
    );

    expect(result.descriptors.map((descriptor) => descriptor.targetId)).toEqual(['codex']);
    await supervisor.close();
  });

  it('aborts a pending workspace authorization through the open shutdown signal', async () => {
    const authorizationStarted = Promise.withResolvers<void>();
    let authorizationSignal: AbortSignal | undefined;
    const value = await fixture({
      authorizeWorkspace: (_path, signal) => {
        authorizationSignal = signal;
        authorizationStarted.resolve();
        return new Promise<never>(() => undefined);
      },
    });
    const opening = openSession(value, 'authorizing-session');
    await authorizationStarted.promise;

    const shutdown = value.supervisor.close();
    await expect(opening).rejects.toThrow(/shutting down/);
    await shutdown;
    expect(authorizationSignal?.aborted).toBe(true);
    expect(value.adapter.opens).toHaveLength(0);
  });

  it('hands every turn the executable that open resolved', async () => {
    const value = await fixture({ resolveExecutable: async () => ({ path: process.execPath }) });
    await openSession(value);

    await value.supervisor.turn({
      sessionId: 'session-1',
      clientMessageId: 'message-1',
      input: 'hello',
      configuration: CONFIGURATION,
    });

    // A vendor that spawns a process per turn — Claude Code's headless stream —
    // has nothing else to spawn from, and cannot re-resolve one itself.
    expect(value.adapter.opens[0]?.context.executablePath).toBe(process.execPath);
    expect(value.adapter.turns[0]?.context.executablePath).toBe(process.execPath);
    await value.supervisor.close();
  });

  it('resolves the toolchain open carried and reuses it for every later turn', async () => {
    const value = await fixture({
      env: { PATH: '/usr/bin' } as NodeJS.ProcessEnv,
      platform: 'linux',
      homeDir: '/home/tester',
      spawnEnvFs: { exists: () => false, readFile: () => null, readDirectory: () => null },
    });

    await value.supervisor.open(
      {
        sessionId: 'session-1',
        targetId: 'codex',
        workspacePath: value.workspacePath,
        configuration: CONFIGURATION,
        resumeMode: 'fallback',
        timeoutMs: 1_000,
        toolchain: { node: '/opt/custom/node/bin/node', bun: 'auto' },
      },
      new AbortController().signal
    );
    await value.supervisor.turn({
      sessionId: 'session-1',
      clientMessageId: 'message-1',
      input: 'hello',
      configuration: CONFIGURATION,
    });

    // A vendor hosted over a per-turn process — Claude Code's headless stream —
    // never re-sends `open`, so the choice `open` resolved has to be kept and
    // reused, not just applied to the first spawn.
    expect(value.adapter.opens[0]?.context.environment.PATH).toBe('/opt/custom/node/bin:/usr/bin');
    expect(value.adapter.turns[0]?.context.environment.PATH).toBe('/opt/custom/node/bin:/usr/bin');
    await value.supervisor.close();
  });

  it('leaves PATH untouched when open carries no toolchain', async () => {
    const value = await fixture({ env: { PATH: '/usr/bin' } as NodeJS.ProcessEnv });
    await openSession(value);

    expect(value.adapter.opens[0]?.context.environment.PATH).toBe('/usr/bin');
    await value.supervisor.close();
  });

  it('streams ordered semantic events and coalesces a retried client message id', async () => {
    const adapter = new FakeExternalAgentAdapter({
      events: [
        { type: 'text_delta', text: 'hello' },
        {
          type: 'approval_requested',
          request: {
            requestId: 'approval-1',
            kind: 'command',
            title: 'Run command',
            options: [
              { id: 'allow', rawLabel: 'Allow', isDestructive: false },
              { id: 'deny', rawLabel: 'Deny', isDestructive: false },
            ],
            expiresAtMs: Date.now() + 1_000,
          },
        },
        { type: 'completed' },
      ],
    });
    const value = await fixture({ adapter });
    await openSession(value);
    const params = {
      sessionId: 'session-1',
      clientMessageId: 'message-1',
      input: 'hello',
      configuration: CONFIGURATION,
    };

    const [first, retry] = await Promise.all([
      value.supervisor.turn(params),
      value.supervisor.turn(params),
    ]);
    expect(first).toEqual({ nativeTurnId: 'turn-1' });
    expect(retry).toEqual(first);
    expect(adapter.turns).toHaveLength(1);

    await waitFor(() => value.events.length === 3);
    expect(value.events.map((event) => (event.payload as { sequence: number }).sequence)).toEqual([
      1, 2, 3,
    ]);
    await value.supervisor.respond({
      sessionId: 'session-1',
      nativeTurnId: 'turn-1',
      requestId: 'approval-1',
      optionId: 'allow',
    });
    expect(adapter.responses).toHaveLength(1);
    await value.supervisor.close();
  });

  it('forwards a steer to the adapter with the native session id attached', async () => {
    const adapter = new FakeExternalAgentAdapter({
      steerable: true,
      capabilities: { steering: true },
    });
    const value = await fixture({ adapter });
    await openSession(value);

    const result = await value.supervisor.steer({
      sessionId: 'session-1',
      nativeTurnId: 'turn-1',
      clientMessageId: 'steer-1',
      input: 'actually use the existing helper',
    });

    expect(result).toEqual({ accepted: true });
    expect(adapter.steers).toEqual([
      {
        sessionId: 'session-1',
        nativeSessionId: 'native-session-1',
        nativeTurnId: 'turn-1',
        clientMessageId: 'steer-1',
        input: 'actually use the existing helper',
      },
    ]);
    await value.supervisor.close();
  });

  it('passes an adapter rejection through unchanged', async () => {
    const adapter = new FakeExternalAgentAdapter({
      steerable: true,
      capabilities: { steering: true },
      steerResult: { accepted: false, reasonCode: 'turn-not-steerable' },
    });
    const value = await fixture({ adapter });
    await openSession(value);

    const result = await value.supervisor.steer({
      sessionId: 'session-1',
      nativeTurnId: 'turn-1',
      clientMessageId: 'steer-1',
      input: 'switch to plan mode',
    });

    expect(result).toEqual({ accepted: false, reasonCode: 'turn-not-steerable' });
    await value.supervisor.close();
  });

  it('answers not-supported without calling an adapter that has no steer member', async () => {
    // The default fixture adapter never assigns `steer`, matching Cursor and
    // Claude: the capability flag and the method's presence cannot disagree,
    // so a session on a non-steering adapter is refused before anything is
    // asked of it.
    const value = await fixture();
    await openSession(value);

    const result = await value.supervisor.steer({
      sessionId: 'session-1',
      nativeTurnId: 'turn-1',
      clientMessageId: 'steer-1',
      input: 'hello?',
    });

    expect(result).toEqual({ accepted: false, reasonCode: 'not-supported' });
    await value.supervisor.close();
  });

  it('refuses a steer against a session that is not open', async () => {
    const value = await fixture();

    await expect(
      value.supervisor.steer({
        sessionId: 'never-opened',
        nativeTurnId: 'turn-1',
        clientMessageId: 'steer-1',
        input: 'hello?',
      })
    ).rejects.toThrow(/is not open/);
    await value.supervisor.close();
  });

  it('bounds concurrent sessions and recovers capacity after close', async () => {
    const value = await fixture({ sessionCap: 1 });
    await openSession(value, 'session-1');

    await expect(openSession(value, 'session-2')).rejects.toThrow(/capacity is 1/);
    await value.supervisor.closeSession({ sessionId: 'session-1' });
    await expect(openSession(value, 'session-2')).resolves.toMatchObject({ resumed: false });
    await value.supervisor.close();
  });

  it('proactively cancels and closes an idle session when consent is revoked', async () => {
    let allow = RUNTIME_CONSENT_PRESETS.full;
    const adapter = new FakeExternalAgentAdapter();
    const value = await fixture({
      adapter,
      consent: { current: () => allow, refresh: async () => allow },
    });
    await openSession(value);

    allow = RUNTIME_CONSENT_PRESETS.none;
    await waitFor(() => adapter.closes.length === 1);
    expect(value.supervisor.health.liveSessionCount).toBe(0);
    expect(adapter.closes[0]?.reason).toBe('consent-revoked');
    await value.supervisor.close();
  });

  it('makes concurrent close calls share the same teardown barrier', async () => {
    const closeGate = Promise.withResolvers<void>();
    const adapter = new FakeExternalAgentAdapter({ closeGate: closeGate.promise });
    const value = await fixture({ adapter });
    await openSession(value);

    let sessionCloseSettled = false;
    let supervisorCloseSettled = false;
    const sessionClose = value.supervisor.closeSession({ sessionId: 'session-1' }).then(() => {
      sessionCloseSettled = true;
    });
    const supervisorClose = value.supervisor.close().then(() => {
      supervisorCloseSettled = true;
    });
    await Bun.sleep(10);
    expect({ sessionCloseSettled, supervisorCloseSettled }).toEqual({
      sessionCloseSettled: false,
      supervisorCloseSettled: false,
    });

    closeGate.resolve();
    await Promise.all([sessionClose, supervisorClose]);
    expect(adapter.closes).toHaveLength(1);
  });

  it('aborts an opening session on close and reaps its late adapter result', async () => {
    const openGate = Promise.withResolvers<void>();
    const adapter = new FakeExternalAgentAdapter({ openGate: openGate.promise });
    const value = await fixture({ adapter });
    const opening = openSession(value, 'closing-opening');
    await waitFor(() => adapter.opens.length === 1);

    let closeSettled = false;
    const closing = value.supervisor.closeSession({ sessionId: 'closing-opening' }).then(() => {
      closeSettled = true;
    });
    await expect(opening).rejects.toThrow(/closed while it was opening/);
    expect(adapter.opens[0]?.context.signal.aborted).toBe(true);
    expect(value.supervisor.health.liveSessionCount).toBe(0);
    await Bun.sleep(0);
    expect(closeSettled).toBe(false);

    openGate.resolve();
    await closing;
    expect(closeSettled).toBe(true);
    expect(adapter.closes).toHaveLength(1);
    expect(adapter.closes[0]).toMatchObject({
      sessionId: 'closing-opening',
      reason: 'requested',
    });
    expect(value.supervisor.health.liveSessionCount).toBe(0);
    await value.supervisor.close();
  });

  it('surfaces a matching late-open reaper failure to explicit close', async () => {
    const openGate = Promise.withResolvers<void>();
    const failure = new Error('late adapter cleanup failed');
    const adapter = new FakeExternalAgentAdapter({ openGate: openGate.promise });
    adapter.close = (input) => {
      adapter.closes.push(input);
      return Promise.reject(failure);
    };
    const value = await fixture({ adapter, cleanupTimeoutMs: 50 });
    const opening = openSession(value, 'failed-late-close');
    await waitFor(() => adapter.opens.length === 1);

    const closing = value.supervisor.closeSession({ sessionId: 'failed-late-close' });
    await expect(opening).rejects.toThrow(/closed while it was opening/);
    openGate.resolve();

    await expect(closing).rejects.toThrow(/late-open cleanup failed/);
    expect(adapter.closes).toHaveLength(1);
    await value.supervisor.close();
  });

  it('bounds explicit close while a late adapter open never settles', async () => {
    const adapter = new FakeExternalAgentAdapter({ hangOpen: true });
    const value = await fixture({ adapter, cleanupTimeoutMs: 5 });
    const opening = openSession(value, 'never-opened', 60_000);
    const openingOutcome = opening.then(
      () => new Error('Expected close to reject the opening.'),
      (error: unknown) => error
    );
    await waitFor(() => adapter.opens.length === 1);

    await expect(value.supervisor.closeSession({ sessionId: 'never-opened' })).rejects.toThrow(
      /late-open cleanup exceeded its deadline/
    );
    expect((await openingOutcome) as Error).toHaveProperty(
      'message',
      expect.stringContaining('closed while it was opening')
    );
    await expect(value.supervisor.close()).rejects.toThrow(/shutdown cleanup failed/);
  });

  it('surfaces a consent-revoked late-open cleanup failure on shutdown', async () => {
    let allow = RUNTIME_CONSENT_PRESETS.full;
    let refreshCalls = 0;
    const revocationRefresh = Promise.withResolvers<void>();
    const openGate = Promise.withResolvers<void>();
    const adapter = new FakeExternalAgentAdapter({ openGate: openGate.promise });
    adapter.close = (input) => {
      adapter.closes.push(input);
      return Promise.reject(new Error('consent late cleanup failed'));
    };
    const value = await fixture({
      adapter,
      cleanupTimeoutMs: 50,
      consent: {
        current: () => allow,
        refresh: () => {
          refreshCalls += 1;
          if (allow.externalAgents !== true) revocationRefresh.resolve();
          return Promise.resolve(allow);
        },
      },
    });
    const opening = openSession(value, 'revoked-opening', 60_000);
    const openingOutcome = opening.then(
      () => new Error('Expected consent revocation to reject the opening.'),
      (error: unknown) => error
    );
    await waitFor(() => adapter.opens.length === 1);
    await waitFor(() => refreshCalls > 0);

    const refreshesBeforeRevocation = refreshCalls;
    allow = RUNTIME_CONSENT_PRESETS.none;
    await waitFor(() => refreshCalls > refreshesBeforeRevocation);
    await Promise.race([
      revocationRefresh.promise,
      Bun.sleep(500).then(() => {
        throw new Error('Timed out waiting for the revoked consent refresh.');
      }),
    ]);
    await waitFor(() => adapter.opens[0]?.context.signal.aborted === true);
    const openingError = await openingOutcome;
    expect(openingError).toBeInstanceOf(Error);
    expect((openingError as Error).message).toContain('consent was revoked');
    openGate.resolve();
    await waitFor(() => adapter.closes.length === 1);
    await Bun.sleep(10);

    await expect(value.supervisor.close()).rejects.toThrow(/shutdown cleanup failed/);
    expect(adapter.closes[0]?.reason).toBe('consent-revoked');
  });

  it('reaps an adapter session that resolves after its open deadline', async () => {
    const openGate = Promise.withResolvers<void>();
    const adapter = new FakeExternalAgentAdapter({ openGate: openGate.promise });
    const value = await fixture({ adapter });

    // Hang inside the adapter before the deadline. A 5ms budget expired during
    // workspace authorization under coverage, so the adapter never started and
    // waitFor sat on a promise that could not settle. The deadline timer is
    // unref'd; waitFor's ref'd sleeps keep the isolate alive until it fires.
    const opening = openSession(value, 'late-session', 1_000);
    const openingOutcome = opening.then(
      () => new Error('Expected the open deadline to reject the session.'),
      (error: unknown) => error
    );
    await waitFor(() => adapter.opens.length === 1);
    await waitFor(() => adapter.opens[0]?.context.signal.aborted === true);
    const openingError = await openingOutcome;
    expect(openingError).toBeInstanceOf(Error);
    expect((openingError as Error).message).toContain('Deadline exceeded');
    expect(value.supervisor.health.liveSessionCount).toBe(0);

    openGate.resolve();
    await waitFor(() => adapter.closes.length === 1);
    expect(adapter.closes[0]).toMatchObject({ sessionId: 'late-session', reason: 'requested' });
    await value.supervisor.close();
  }, 15_000);

  it('keeps watching consent for a pending reaper after open cancellation', async () => {
    let allow = RUNTIME_CONSENT_PRESETS.full;
    let refreshCalls = 0;
    const revokedRefresh = Promise.withResolvers<void>();
    const openGate = Promise.withResolvers<void>();
    const adapter = new FakeExternalAgentAdapter({ openGate: openGate.promise });
    const value = await fixture({
      adapter,
      cleanupTimeoutMs: 100,
      consent: {
        current: () => allow,
        refresh: () => {
          refreshCalls += 1;
          if (allow.externalAgents !== true) revokedRefresh.resolve();
          return Promise.resolve(allow);
        },
      },
    });

    const request = new AbortController();
    const opening = openSession(value, 'cancelled-before-revocation', 60_000, request.signal);
    await waitFor(() => adapter.opens.length === 1);
    request.abort(new Error('fixture request cancelled'));
    await expect(opening).rejects.toThrow(/fixture request cancelled/);
    expect(value.supervisor.health.liveSessionCount).toBe(0);
    const refreshesBeforeRevocation = refreshCalls;

    allow = RUNTIME_CONSENT_PRESETS.none;
    await Promise.race([
      revokedRefresh.promise,
      Bun.sleep(500).then(() => {
        throw new Error('Consent watcher stopped while a late-open reaper was pending.');
      }),
    ]);
    expect(refreshCalls).toBeGreaterThan(refreshesBeforeRevocation);
    await Bun.sleep(0);

    openGate.resolve();
    await waitFor(() => adapter.closes.length === 1);
    expect(adapter.closes[0]).toMatchObject({
      sessionId: 'cancelled-before-revocation',
      reason: 'consent-revoked',
    });
    expect(value.supervisor.health.liveSessionCount).toBe(0);

    await Bun.sleep(20);
    const settledRefreshCalls = refreshCalls;
    await Bun.sleep(20);
    expect(refreshCalls).toBe(settledRefreshCalls);
    await value.supervisor.close();
  });

  it('aborts and refuses to register an opening session during shutdown', async () => {
    const openGate = Promise.withResolvers<void>();
    const adapter = new FakeExternalAgentAdapter({ openGate: openGate.promise });
    const value = await fixture({ adapter });
    const opening = openSession(value, 'shutdown-opening');
    await waitFor(() => adapter.opens.length === 1);

    let shutdownSettled = false;
    const shutdown = value.supervisor.close().then(() => {
      shutdownSettled = true;
    });
    await expect(opening).rejects.toThrow(/shutting down/);
    expect(value.supervisor.health.liveSessionCount).toBe(0);
    await Bun.sleep(0);
    expect(shutdownSettled).toBe(false);

    openGate.resolve();
    await shutdown;
    expect(shutdownSettled).toBe(true);
    expect(adapter.closes).toHaveLength(1);
    expect(adapter.closes[0]?.reason).toBe('shutdown');
  });

  it('does not emit an event delivered after consent revokes an active turn', async () => {
    let allow = RUNTIME_CONSENT_PRESETS.full;
    const nextEvent = Promise.withResolvers<IteratorResult<ExternalAgentEvent>>();
    let iteratorReturned = false;
    const adapter = new FakeExternalAgentAdapter();
    adapter.startTurn = (input) => {
      adapter.turns.push(input);
      return {
        nativeTurnId: 'turn-1',
        [Symbol.asyncIterator]() {
          return {
            next: () => nextEvent.promise,
            return: () => {
              iteratorReturned = true;
              return Promise.resolve({ done: true as const, value: undefined });
            },
          };
        },
      };
    };
    const value = await fixture({
      adapter,
      consent: { current: () => allow, refresh: async () => allow },
    });
    await openSession(value);
    await value.supervisor.turn({
      sessionId: 'session-1',
      clientMessageId: 'revoked-mid-turn',
      input: 'wait',
      configuration: CONFIGURATION,
    });

    allow = RUNTIME_CONSENT_PRESETS.none;
    await waitFor(() => adapter.closes.length === 1);
    expect(adapter.turns[0]?.context.signal.aborted).toBe(true);

    nextEvent.resolve({ done: false, value: { type: 'text_delta', text: 'too late' } });
    await waitFor(() => iteratorReturned);
    expect(value.events).toHaveLength(0);
    await value.supervisor.close();
  });

  it('preserves adapter-owned environment keys through managed process launch', async () => {
    const adapter = new FakeExternalAgentAdapter();
    Object.defineProperty(adapter, 'vendorEnvironmentKeys', {
      value: ['VENDOR_CONFIG'],
    });
    const value = await fixture({
      adapter,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        VENDOR_CONFIG: 'adapter-owned',
        CONNECTOR_SECRET: 'never-forward-this',
      },
    });
    await openSession(value);

    const child = adapter.opens[0]?.context.spawn({
      argv: [
        process.execPath,
        resolve(import.meta.dir, '../../support/external-agent-fixture.ts'),
        '--mode',
        'environment',
      ],
    });
    if (!child) throw new Error('Expected the adapter open context.');
    const record = await child.stdout.next(1_000);
    const environment = JSON.parse(record.kind === 'line' ? record.line : '{}') as Record<
      string,
      string
    >;
    expect(environment.VENDOR_CONFIG).toBe('adapter-owned');
    expect(environment.CONNECTOR_SECRET).toBeUndefined();
    await child.exit;
    await value.supervisor.close();
  });

  it('surfaces managed process cleanup failure from supervisor shutdown', async () => {
    const adapter = new FakeExternalAgentAdapter();
    const value = await fixture({ adapter });
    await openSession(value);
    const child = adapter.opens[0]?.context.spawn({
      argv: [
        process.execPath,
        resolve(import.meta.dir, '../../support/external-agent-fixture.ts'),
        '--mode',
        'graceful',
      ],
    });
    if (!child) throw new Error('Expected the adapter open context.');
    const terminate = child.terminate;
    child.terminate = () => Promise.reject(new Error('fixture cleanup failed'));

    try {
      await expect(value.supervisor.close()).rejects.toThrow(/shutdown cleanup failed/);
    } finally {
      child.terminate = terminate;
      await child.terminate({ graceMs: 10 });
    }
  });

  it('sanitizes and bounds vendor display strings before emitting them', async () => {
    const escapeChar = String.fromCodePoint(0x1b);
    const bidiOverride = String.fromCodePoint(0x202e);
    const adapter = new FakeExternalAgentAdapter({
      events: [
        {
          type: 'activity_started',
          callId: 'call-1',
          activity: {
            name: 'x'.repeat(EXTERNAL_TEXT_LIMITS.activityName + 10),
            kind: 'command',
            title: `safe${escapeChar}[31m title`,
          },
        },
        { type: 'text_delta', text: `hello${bidiOverride}world` },
        { type: 'completed' },
      ],
    });
    const value = await fixture({ adapter });
    await openSession(value);
    await value.supervisor.turn({
      sessionId: 'session-1',
      clientMessageId: 'bounded-message',
      input: 'go',
      configuration: CONFIGURATION,
    });

    await waitFor(() => value.events.length === 3);
    expect(value.events[0]?.payload).toMatchObject({
      event: {
        type: 'activity_started',
        activity: {
          name: 'x'.repeat(EXTERNAL_TEXT_LIMITS.activityName),
          title: 'safe[31m title',
          truncated: true,
        },
      },
    });
    expect(value.events[1]?.payload).toMatchObject({
      event: { type: 'text_delta', text: 'helloworld' },
    });
    await value.supervisor.close();
  });

  it('stops a turn before an oversized aggregate payload leaves the runtime', async () => {
    const adapter = new FakeExternalAgentAdapter({
      events: [
        {
          type: 'text_delta',
          text: 'x'.repeat(EXTERNAL_TURN_PAYLOAD_MAX_BYTES),
        },
      ],
    });
    const value = await fixture({ adapter });
    await openSession(value);
    await value.supervisor.turn({
      sessionId: 'session-1',
      clientMessageId: 'oversized-message',
      input: 'go',
      configuration: CONFIGURATION,
    });

    await waitFor(() => adapter.cancellations.length === 1);
    expect(adapter.turns[0]?.context.signal.aborted).toBe(true);
    expect(value.events).toHaveLength(1);
    expect(value.events[0]?.payload).toMatchObject({
      event: {
        type: 'error',
        error: { code: 'adapter-stream', message: expect.stringContaining('payload limit') },
      },
    });
    await value.supervisor.close();
  });

  it('refuses an unbounded native turn id and aborts its adapter context', async () => {
    const adapter = new FakeExternalAgentAdapter({ nativeTurnId: 'x'.repeat(129) });
    const value = await fixture({ adapter });
    await openSession(value);

    expect(() =>
      value.supervisor.turn({
        sessionId: 'session-1',
        clientMessageId: 'invalid-id-message',
        input: 'go',
        configuration: CONFIGURATION,
      })
    ).toThrow(/invalid native turn id/);
    await waitFor(() => adapter.cancellations.length === 1);
    expect(adapter.turns[0]?.context.signal.aborted).toBe(true);
    expect(value.events).toHaveLength(0);
    await value.supervisor.close();
  });

  it('turns a mid-stream adapter crash into a bounded error and cancellation', async () => {
    const adapter = new FakeExternalAgentAdapter({
      events: [{ type: 'text_delta', text: 'before crash' }],
      turnError: new Error('fixture crashed'),
    });
    const value = await fixture({ adapter });
    await openSession(value);
    await value.supervisor.turn({
      sessionId: 'session-1',
      clientMessageId: 'crash-message',
      input: 'go',
      configuration: CONFIGURATION,
    });

    await waitFor(() => adapter.cancellations.length === 1);
    expect(value.events.map((event) => event.payload)).toMatchObject([
      { event: { type: 'text_delta', text: 'before crash' } },
      { event: { type: 'error', error: { message: 'fixture crashed' } } },
    ]);
    await value.supervisor.close();
  });

  it('refuses unknown additive and host-tool event shapes at the runtime boundary', async () => {
    const invalidEvents = [
      { type: 'completed', vendorExtension: true },
      { type: 'host_tool_requested', toolName: 'write-file', arguments: {} },
    ];

    for (const [index, invalidEvent] of invalidEvents.entries()) {
      const adapter = new FakeExternalAgentAdapter({
        events: [invalidEvent as never],
      });
      const value = await fixture({ adapter });
      await openSession(value, `invalid-event-${index}`);
      await value.supervisor.turn({
        sessionId: `invalid-event-${index}`,
        clientMessageId: `invalid-event-message-${index}`,
        input: 'go',
        configuration: CONFIGURATION,
      });

      await waitFor(() => adapter.cancellations.length === 1);
      expect(value.events).toHaveLength(1);
      expect(value.events[0]?.payload).toMatchObject({
        event: { type: 'error', error: { code: 'adapter-stream' } },
      });
      await value.supervisor.close();
    }
  });

  it('enforces the hard turn deadline even while a stream remains active', async () => {
    const adapter = new FakeExternalAgentAdapter({ hangTurn: true, events: [] });
    const value = await fixture({ adapter, idleTimeoutMs: 1_000, hardTurnTimeoutMs: 5 });
    await openSession(value);
    await value.supervisor.turn({
      sessionId: 'session-1',
      clientMessageId: 'hard-timeout-message',
      input: 'hang',
      configuration: CONFIGURATION,
    });

    await waitFor(() => adapter.cancellations.length === 1);
    expect(adapter.cancellations[0]?.reason).toBe('timeout');
    expect(adapter.turns[0]?.context.signal.aborted).toBe(true);
    expect(value.events[0]?.payload).toMatchObject({
      event: {
        type: 'error',
        error: { message: expect.stringContaining('hard timeout') },
      },
    });
    await value.supervisor.close();
  });

  it('cancels a stream that exceeds the idle deadline and emits a bounded error', async () => {
    const adapter = new FakeExternalAgentAdapter({ hangTurn: true, events: [] });
    const value = await fixture({ adapter, idleTimeoutMs: 5 });
    await openSession(value);
    await value.supervisor.turn({
      sessionId: 'session-1',
      clientMessageId: 'message-1',
      input: 'hang',
      configuration: CONFIGURATION,
    });

    await waitFor(() => adapter.cancellations.length === 1);
    expect(adapter.cancellations[0]?.reason).toBe('timeout');
    expect(adapter.turns[0]?.context.signal.aborted).toBe(true);
    expect(value.events[0]?.payload).toMatchObject({
      sequence: 1,
      event: { type: 'error', error: { code: 'adapter-stream' } },
    });
    await value.supervisor.close();
  });

  it('does not treat a turn awaiting an approval as an idle stream', async () => {
    // A turn blocked on an approval produces no events by definition: it is
    // waiting on a person. Reading that as a stalled vendor would kill the turn
    // while the user is still reading the diff, so the approval's own
    // `expiresAtMs` — not the idle timeout — bounds the wait.
    const adapter = new FakeExternalAgentAdapter({
      hangTurn: true,
      events: [
        {
          type: 'approval_requested',
          request: {
            requestId: 'req-1',
            kind: 'command',
            title: 'rm -rf build',
            options: [{ id: 'accept', isDestructive: false }],
            expiresAtMs: Date.now() + 60_000,
          },
        },
      ],
    });
    const value = await fixture({ adapter, idleTimeoutMs: 5 });
    await openSession(value);
    await value.supervisor.turn({
      sessionId: 'session-1',
      clientMessageId: 'message-1',
      input: 'run it',
      configuration: CONFIGURATION,
    });

    await waitFor(() => value.events.length === 1);
    await Bun.sleep(60);
    expect(adapter.cancellations).toEqual([]);
    expect(value.events).toHaveLength(1);
    expect(value.events[0]?.payload).toMatchObject({
      event: { type: 'approval_requested' },
    });
    await value.supervisor.close();
  });

  it('stops extending the wait once the approval has expired', async () => {
    // Stamp the TTL on first read, which is when the supervisor records the
    // event. Constructing Date.now()+N before fixture/open left coverage
    // already past the stamp, so the next wait used the 5ms idle path.
    let expiresAtMs = 0;
    const adapter = new FakeExternalAgentAdapter({
      hangTurn: true,
      events: [
        {
          type: 'approval_requested',
          request: {
            requestId: 'req-1',
            kind: 'command',
            title: 'rm -rf build',
            options: [{ id: 'accept', isDestructive: false }],
            get expiresAtMs() {
              if (expiresAtMs === 0) expiresAtMs = Date.now() + 500;
              return expiresAtMs;
            },
          },
        },
      ],
    });
    const value = await fixture({ adapter, idleTimeoutMs: 5 });
    await openSession(value);
    await value.supervisor.turn({
      sessionId: 'session-1',
      clientMessageId: 'message-1',
      input: 'run it',
      configuration: CONFIGURATION,
    });

    await waitFor(() => value.events.length === 1);
    expect(value.events[0]?.payload).toMatchObject({
      event: { type: 'approval_requested' },
    });
    await waitFor(() => adapter.cancellations.length === 1);
    expect(adapter.cancellations[0]?.reason).toBe('timeout');
    expect(value.events.at(-1)?.payload).toMatchObject({
      event: {
        type: 'error',
        error: { message: expect.stringContaining('waiting for an approval') },
      },
    });
    await value.supervisor.close();
  });
});

/**
 * Waits for fixture state to settle.
 *
 * The deadline is harness headroom, not an assertion about how fast anything
 * has to be — every caller is waiting on an ordering guarantee, and none of
 * them cares whether it takes one millisecond or one second. It is generous
 * because it is wall-clock and shared with everything else in the process: at
 * one second, adding unrelated test files to the same run was enough to fail
 * the late-open reaper case under coverage instrumentation, which is a
 * statement about machine load rather than about the supervisor.
 */
const FIXTURE_SETTLE_TIMEOUT_MS = 10_000;

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + FIXTURE_SETTLE_TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture state.');
    await Bun.sleep(5);
  }
}

describe('external-agent session listing', () => {
  const SESSION = {
    targetId: 'codex' as const,
    nativeSessionId: 'thread-1',
    title: 'Fix the flaky test',
    workspacePath: '/workspace',
    updatedAtMs: 1_786_284_100_000,
  };

  it('refuses a listing for a workspace the owner never authorized', async () => {
    // A listing reads the first lines of somebody's conversations. It is not a
    // lesser operation than opening a session, and it answers to the same
    // workspace policy.
    const value = await fixture({
      adapter: new FakeExternalAgentAdapter({ listedSessions: [SESSION] }),
      authorizeWorkspace: () => false,
    });

    await expect(
      value.supervisor.listSessions(
        { targetId: 'codex', workspacePath: value.workspacePath, timeoutMs: 1_000 },
        new AbortController().signal
      )
    ).rejects.toThrow(/not authorized/);
    expect((value.adapter as FakeExternalAgentAdapter).listings).toHaveLength(0);
  });

  it('passes the canonical workspace through to the adapter', async () => {
    const adapter = new FakeExternalAgentAdapter({ listedSessions: [SESSION] });
    const value = await fixture({ adapter });

    const page = await value.supervisor.listSessions(
      { targetId: 'codex', workspacePath: value.workspacePath, limit: 5, timeoutMs: 1_000 },
      new AbortController().signal
    );

    expect(page.sessions).toHaveLength(1);
    expect(adapter.listings[0]).toMatchObject({
      workspacePath: value.workspacePath,
      limit: 5,
    });
  });

  it('refuses a target whose adapter has no listing', async () => {
    const value = await fixture();
    await expect(
      value.supervisor.listSessions(
        { targetId: 'codex', timeoutMs: 1_000 },
        new AbortController().signal
      )
    ).rejects.toThrow(/cannot list sessions/);
  });

  it('bounds vendor text and drops a row whose id could not survive it', async () => {
    const adapter = new FakeExternalAgentAdapter({
      listedSessions: [
        { ...SESSION, title: 'x'.repeat(EXTERNAL_TEXT_LIMITS.sessionTitle + 40) },
        // An id past the vendor-id bound is a pointer to nothing: truncating it
        // would adopt a different conversation, so the row goes instead.
        { ...SESSION, nativeSessionId: 'y'.repeat(EXTERNAL_TEXT_LIMITS.vendorId + 1) },
      ],
    });
    const value = await fixture({ adapter });

    const page = await value.supervisor.listSessions(
      { targetId: 'codex', timeoutMs: 1_000 },
      new AbortController().signal
    );

    expect(page.sessions).toHaveLength(1);
    expect([...(page.sessions[0]?.title ?? '')]).toHaveLength(EXTERNAL_TEXT_LIMITS.sessionTitle);
  });
});

describe('external-agent native review', () => {
  const REVIEW = {
    sessionId: 'session-1',
    clientMessageId: 'message-1',
    target: { type: 'uncommittedChanges' as const },
  };

  it('streams a review through the same session, sequence and topic a turn uses', async () => {
    const adapter = new FakeExternalAgentAdapter({
      reviewable: true,
      capabilities: { nativeReview: true },
      events: [
        { type: 'text_delta', text: 'P1: the retry loop never exits.' },
        { type: 'completed' },
      ],
    });
    const value = await fixture({ adapter });
    await openSession(value);

    const started = await value.supervisor.startReview(REVIEW);
    expect(started.nativeTurnId).toBe('message-1');
    expect(started.reviewThreadId).toBe('native-session-1');
    await waitFor(() => value.events.length >= 2);

    // No second event path: a review's events travel the session's own topic,
    // under the session's own sequence, exactly like a turn's.
    expect(value.events.map((event) => event.payload)).toMatchObject([
      { sessionId: 'session-1', nativeTurnId: 'message-1', sequence: 1 },
      { sessionId: 'session-1', nativeTurnId: 'message-1', sequence: 2 },
    ]);
    expect(adapter.reviews[0]?.params.target).toEqual({ type: 'uncommittedChanges' });
  });

  it('refuses to open a session that advertises nativeReview without implementing it', async () => {
    // The flag cannot disagree with the implementation: an adapter claiming a
    // review surface it does not have is refused at open, before any user
    // action can reach a member that is not there.
    const value = await fixture({
      adapter: new FakeExternalAgentAdapter({ capabilities: { nativeReview: true } }),
    });

    await expect(openSession(value)).rejects.toThrow(/advertises nativeReview=true/);
  });

  it('refuses a review on a session whose open reported no nativeReview', async () => {
    // The other direction: the member exists, and this machine's build said it
    // cannot review. The session's own answer wins over the class's shape.
    const value = await fixture({ adapter: new FakeExternalAgentAdapter({ reviewable: true }) });
    await openSession(value);

    expect(() => value.supervisor.startReview(REVIEW)).toThrow(/cannot start a native review/);
  });

  it('answers a repeated review id from its receipt instead of running a second one', async () => {
    const adapter = new FakeExternalAgentAdapter({
      reviewable: true,
      capabilities: { nativeReview: true },
    });
    const value = await fixture({ adapter });
    await openSession(value);

    const first = await value.supervisor.startReview(REVIEW);
    const second = await value.supervisor.startReview(REVIEW);

    expect(second).toEqual(first);
    expect(adapter.reviews).toHaveLength(1);
  });

  it("holds the session's turn slot across the review call, so a send cannot slip in", async () => {
    // `review/start` is awaited — it is the only start call that suspends
    // between checking for an active turn and registering one — so the slot is
    // taken before the await rather than after it.
    const openReview = Promise.withResolvers<void>();
    const adapter = new FakeExternalAgentAdapter({
      reviewable: true,
      capabilities: { nativeReview: true },
      reviewGate: openReview.promise,
    });
    const value = await fixture({ adapter });
    await openSession(value);

    const review = value.supervisor.startReview(REVIEW);
    expect(() =>
      value.supervisor.turn({
        sessionId: 'session-1',
        clientMessageId: 'message-2',
        input: 'hello',
        configuration: CONFIGURATION,
      })
    ).toThrow(/already has an active turn/);

    openReview.resolve();
    await review;
  });

  it('releases the slot when the review call itself fails', async () => {
    const adapter = new FakeExternalAgentAdapter({
      reviewable: true,
      capabilities: { nativeReview: true },
      reviewFailure: () => new Error('review/start refused'),
    });
    const value = await fixture({ adapter });
    await openSession(value);

    await expect(value.supervisor.startReview(REVIEW)).rejects.toThrow('review/start refused');
    // A review that never started holds nothing.
    await expect(
      value.supervisor.turn({
        sessionId: 'session-1',
        clientMessageId: 'message-2',
        input: 'hello',
        configuration: CONFIGURATION,
      })
    ).resolves.toMatchObject({ nativeTurnId: 'turn-1' });
  });

  it('refuses a review while a turn is already running on the session', async () => {
    const adapter = new FakeExternalAgentAdapter({
      reviewable: true,
      capabilities: { nativeReview: true },
      hangTurn: true,
    });
    const value = await fixture({ adapter });
    await openSession(value);

    await value.supervisor.turn({
      sessionId: 'session-1',
      clientMessageId: 'message-0',
      input: 'hello',
      configuration: CONFIGURATION,
    });
    expect(() => value.supervisor.startReview(REVIEW)).toThrow(/already has an active turn/);
  });

  it('cancels a pending review when the protocol request is aborted', async () => {
    const openReview = Promise.withResolvers<void>();
    const adapter = new FakeExternalAgentAdapter({
      reviewable: true,
      capabilities: { nativeReview: true },
      reviewGate: openReview.promise,
    });
    const value = await fixture({ adapter });
    await openSession(value);

    const request = new AbortController();
    const review = value.supervisor.startReview(REVIEW, request.signal);
    request.abort(new Error('hub timed out'));
    await expect(review).rejects.toThrow('hub timed out');
    expect(adapter.cancellations).toHaveLength(1);
    expect(adapter.reviews[0]?.context.signal.aborted).toBe(true);

    openReview.resolve();
    await expect(
      value.supervisor.turn({
        sessionId: 'session-1',
        clientMessageId: 'message-2',
        input: 'hello',
        configuration: CONFIGURATION,
      })
    ).resolves.toMatchObject({ nativeTurnId: 'turn-1' });
  });

  it('releases the reservation when review turn registration fails', async () => {
    const adapter = new FakeExternalAgentAdapter({
      reviewable: true,
      capabilities: { nativeReview: true },
      reviewNativeTurnId: 'x'.repeat(EXTERNAL_TEXT_LIMITS.vendorId + 1),
    });
    const value = await fixture({ adapter });
    await openSession(value);

    await expect(value.supervisor.startReview(REVIEW)).rejects.toThrow(/invalid native turn id/);
    await expect(
      value.supervisor.turn({
        sessionId: 'session-1',
        clientMessageId: 'message-2',
        input: 'hello',
        configuration: CONFIGURATION,
      })
    ).resolves.toMatchObject({ nativeTurnId: 'turn-1' });
  });
});
