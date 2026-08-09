import { describe, expect, it } from 'bun:test';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ExternalAgentEvent } from '@mangostudio/shared/external-agents';
import {
  EXTERNAL_TEXT_LIMITS,
  EXTERNAL_TURN_PAYLOAD_MAX_BYTES,
} from '@mangostudio/shared/external-agents';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import type { RuntimeEventInput } from '../../../src/host';
import { createLocalRuntimeManifest } from '../../../src/manifest';
import { ExternalAgentAdapterRegistry } from '../../../src/services/external-agents/registry';
import { ExternalAgentSessionSupervisor } from '../../../src/services/external-agents/supervisor';
import { FakeExternalAgentAdapter } from '../../support/fake-external-agent-adapter';

const CONFIGURATION = {
  level: 'default' as const,
  routing: 'user' as const,
  workspaceRoots: [] as readonly string[],
};

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
    readonly env?: NodeJS.ProcessEnv;
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
    resolveExecutable: async () => ({ path: process.execPath }),
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

    await expect(openSession(value, 'late-session', 5)).rejects.toThrow(/Deadline exceeded/);
    expect(value.supervisor.health.liveSessionCount).toBe(0);

    openGate.resolve();
    await waitFor(() => adapter.closes.length === 1);
    expect(adapter.closes[0]).toMatchObject({ sessionId: 'late-session', reason: 'requested' });
    await value.supervisor.close();
  });

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
      cwd: value.workspacePath,
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
      cwd: value.workspacePath,
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
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture state.');
    await Bun.sleep(5);
  }
}
