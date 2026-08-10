import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { ExternalAgentEvent } from '@mangostudio/shared/external-agents';
import type {
  ExternalAgentAdapterContext,
  ExternalAgentAdapterSpawnOptions,
} from '../../../src/services/external-agents/adapter';
import { CursorAcpAdapter } from '../../../src/services/external-agents/cursor/adapter';
import type { ExternalAgentManagedProcess } from '../../../src/services/external-agents/process';
import { CURSOR_TRANSCRIPT } from '../../support/cursor-fixtures';
import {
  createFakeCursorProcess,
  type FakeCursorAcpServer,
  type FakeCursorOptions,
} from '../../support/fake-cursor-acp-server';

interface Harness {
  readonly context: ExternalAgentAdapterContext;
  readonly server: () => FakeCursorAcpServer | undefined;
  readonly launches: () => number;
  readonly controller: AbortController;
}

/**
 * Everything the supervisor would provide, minus the supervisor.
 *
 * `spawn` answers `--version` with a banner, `status --format json` with the
 * recorded status document, and `acp` with the fake vendor — which is exactly
 * the three-branch shape the adapter takes.
 */
function harness(
  options: FakeCursorOptions & {
    readonly banner?: string | null;
    readonly status?: unknown;
    readonly executablePath?: string | undefined;
  } = {}
): Harness {
  const controller = new AbortController();
  let server: FakeCursorAcpServer | undefined;
  let launches = 0;
  const banner = options.banner === undefined ? '2026.08.04-aaa8809' : options.banner;
  const status = options.status === undefined ? CURSOR_TRANSCRIPT.status : options.status;

  const context: ExternalAgentAdapterContext = {
    signal: controller.signal,
    ...('executablePath' in options
      ? options.executablePath === undefined
        ? {}
        : { executablePath: options.executablePath }
      : { executablePath: '/usr/local/bin/cursor-agent' }),
    cwd: '/workspace',
    environment: {},
    spawn: (spawnOptions: ExternalAgentAdapterSpawnOptions): ExternalAgentManagedProcess => {
      if (spawnOptions.argv.includes('--version')) return linesProcess(banner ? [banner] : []);
      if (spawnOptions.argv.includes('status')) {
        return linesProcess(status === null ? [] : [JSON.stringify(status)]);
      }
      launches += 1;
      // Flakiness lives across process launches, not inside one: the adapter
      // retries by starting a *new* `cursor-agent acp`, so a fake that only
      // failed its own first handshake would never fail twice.
      const scenario =
        options.scenario === 'flaky-handshake'
          ? launches === 1
            ? ('handshake-refused' as const)
            : ('text' as const)
          : options.scenario;
      const fake = createFakeCursorProcess({ ...options, ...(scenario ? { scenario } : {}) });
      server = fake.server;
      return fake.managed;
    },
  };
  return { context, server: () => server, launches: () => launches, controller };
}

function linesProcess(lines: readonly string[]): ExternalAgentManagedProcess {
  let index = 0;
  return {
    pid: -1,
    stdout: {
      next: () =>
        Promise.resolve(
          index < lines.length
            ? ({ kind: 'line', line: lines[index++] as string } as const)
            : ({ kind: 'eof' } as const)
        ),
      close: () => undefined,
    },
    exit: Promise.resolve({ code: 0, signal: null }),
    writeLine: () => Promise.resolve(),
    stderrTail: () => '',
    terminate: () => Promise.resolve(),
  };
}

const CONFIGURATION = {
  level: 'default',
  routing: 'user',
  workspaceRoots: ['/workspace'],
} as const;

function openParams(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    targetId: 'cursor' as const,
    workspacePath: '/workspace',
    configuration: { ...CONFIGURATION },
    resumeMode: 'fallback' as const,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function turnParams(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    clientMessageId: 'msg-1',
    input: 'run echo',
    configuration: { ...CONFIGURATION },
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<ExternalAgentEvent>): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('cursor adapter — discovery', () => {
  it('derives capabilities from the handshake, not from a table', async () => {
    const adapter = new CursorAcpAdapter();
    const descriptor = await adapter.discover(harness().context);

    expect(descriptor).toMatchObject({
      targetId: 'cursor',
      installed: true,
      version: '2026.08.04-aaa8809',
      authState: 'signed-in',
    });
    expect(descriptor.capabilities).toMatchObject({
      interactiveApprovals: true,
      reasoningStream: true,
      cancellation: true,
      resume: true,
      sessionListing: true,
      images: true,
      modelCatalog: true,
      usageReporting: false,
      steering: false,
      nativeReview: false,
    });
  });

  it('changes the descriptor when the handshake changes', async () => {
    // The point of deriving rather than declaring: a build that stopped
    // advertising `loadSession` must stop advertising `resume`.
    const adapter = new CursorAcpAdapter();
    const descriptor = await adapter.discover(harness({ scenario: 'no-load-session' }).context);

    expect(descriptor.capabilities.resume).toBe(false);
  });

  it('hides the model selector rather than rendering an empty one', async () => {
    const adapter = new CursorAcpAdapter();
    const descriptor = await adapter.discover(harness({ scenario: 'no-models' }).context);

    expect(descriptor.models).toBeUndefined();
    expect(descriptor.capabilities.modelCatalog).toBe(false);
  });

  it('passes a parameterized model id through verbatim', async () => {
    const adapter = new CursorAcpAdapter();
    const descriptor = await adapter.discover(harness().context);

    expect(descriptor.models?.map((model) => model.id)).toContain(
      'claude-opus-5[thinking=true,context=300k,effort=high,fast=false]'
    );
  });

  it('offers `read-only` and `default` with `user`, and refuses the rest with reasons', async () => {
    const adapter = new CursorAcpAdapter();
    const descriptor = await adapter.discover(harness().context);
    const byPair = new Map(
      descriptor.supportedConfigurations.map((entry) => [`${entry.level}/${entry.routing}`, entry])
    );

    expect(descriptor.supportedConfigurations).toHaveLength(6);
    expect(byPair.get('read-only/user')).toMatchObject({ supported: true, vendorId: 'plan' });
    expect(byPair.get('default/user')).toMatchObject({ supported: true, vendorId: 'agent' });
    expect(byPair.get('full-access/user')).toMatchObject({
      supported: false,
      unsupportedReasonKey: 'externalAgents.unsupported.cursorNoFullAccess',
      unattended: true,
    });
    expect(byPair.get('default/auto-review')).toMatchObject({
      supported: false,
      unsupportedReasonKey: 'externalAgents.unsupported.cursorNoAutoReview',
    });
  });

  it('makes the target unavailable when the handshake negotiates another protocol', async () => {
    const adapter = new CursorAcpAdapter();
    const descriptor = await adapter.discover(harness({ scenario: 'protocol-mismatch' }).context);

    // Never a silent downgrade: the frames the reducer knows are protocol 1's.
    expect(descriptor.capabilities.interactiveApprovals).toBe(false);
    expect(descriptor.supportedConfigurations.every((entry) => !entry.supported)).toBe(true);
    expect(descriptor.discovery?.failureCode).toBe('cursor-protocol-unsupported');
  });

  it('refuses a build older than the pin without launching one', async () => {
    const probe = harness({ banner: '2026.07.16-899851b' });
    const descriptor = await new CursorAcpAdapter().discover(probe.context);

    expect(probe.launches()).toBe(0);
    expect(descriptor.supportedConfigurations[0]?.unsupportedReasonKey).toBe(
      'externalAgents.unsupported.cursorVersionTooOld'
    );
  });

  it('reports a missing CLI as not installed', async () => {
    const descriptor = await new CursorAcpAdapter().discover(
      harness({ executablePath: undefined }).context
    );

    expect(descriptor).toMatchObject({ installed: false, loginCommand: 'cursor-agent login' });
  });

  it('never returns the raw email, and fingerprints it under a host-local key', async () => {
    const adapter = new CursorAcpAdapter();
    const descriptor = await adapter.discover(harness().context);

    const serialized = JSON.stringify(descriptor);
    expect(serialized).not.toContain('someone@example.com');
    expect(descriptor.account?.label).toBe('Cursor');
    // An unkeyed digest is testable offline against a guessed address, which is
    // the personal data the label was dropped to protect.
    const unkeyed = createHash('sha256').update('cursor:someone@example.com').digest('hex');
    expect(descriptor.account?.fingerprint).not.toBe(unkeyed.slice(0, 32));
  });

  it('reports a signed-out account with the command that fixes it', async () => {
    const descriptor = await new CursorAcpAdapter().discover(
      harness({ status: { status: 'unauthenticated', isAuthenticated: false } }).context
    );

    expect(descriptor).toMatchObject({
      authState: 'signed-out',
      loginCommand: 'cursor-agent login',
    });
  });
});

describe('cursor adapter — discovery caching', () => {
  it('answers a second call from the cache instead of relaunching', async () => {
    const adapter = new CursorAcpAdapter();
    const probe = harness();

    const first = await adapter.discover(probe.context);
    const second = await adapter.discover(probe.context);

    expect(first.discovery).toMatchObject({ source: 'live', attempts: 1 });
    expect(second.discovery).toMatchObject({ source: 'cache', attempts: 1 });
    expect(second.discovery?.probedAtMs).toBe(first.discovery?.probedAtMs as number);
    expect(probe.launches()).toBe(1);
  });

  it('re-probes when the CLI version changes under it', async () => {
    const adapter = new CursorAcpAdapter();
    await adapter.discover(harness().context);
    const upgraded = harness({ banner: '2026.09.01-bbb0000' });
    const after = await adapter.discover(upgraded.context);

    expect(after.discovery?.source).toBe('live');
    expect(upgraded.launches()).toBe(1);
  });

  it('re-probes when the signed-in account changes', async () => {
    const adapter = new CursorAcpAdapter();
    await adapter.discover(harness().context);
    const switched = harness({
      status: { ...CURSOR_TRANSCRIPT.status, userInfo: { email: 'other@example.com' } },
    });
    const after = await adapter.discover(switched.context);

    expect(after.discovery?.source).toBe('live');
  });

  it('retries a cold handshake once and records that it did', async () => {
    const adapter = new CursorAcpAdapter();
    const descriptor = await adapter.discover(harness({ scenario: 'flaky-handshake' }).context);

    expect(descriptor.discovery).toMatchObject({ source: 'live', attempts: 2 });
    expect(descriptor.capabilities.interactiveApprovals).toBe(true);
  });

  it('remembers a failure so a broken install does not stall every render', async () => {
    const adapter = new CursorAcpAdapter();
    const probe = harness({ scenario: 'handshake-refused' });

    const first = await adapter.discover(probe.context);
    const second = await adapter.discover(probe.context);

    expect(first.discovery).toMatchObject({ source: 'live', attempts: 2 });
    expect(first.discovery?.failureCode).toBeDefined();
    expect(second.discovery?.source).toBe('cache');
    // Two attempts on the first call, none on the second.
    expect(probe.launches()).toBe(2);
  });
});

describe('cursor adapter — sessions', () => {
  it('puts the permission level in force with `session/set_mode`', async () => {
    const adapter = new CursorAcpAdapter();
    const probe = harness();
    const opened = await adapter.openSession({
      params: openParams({ configuration: { ...CONFIGURATION, level: 'read-only' } }),
      context: probe.context,
    });

    // `session/new` ignores a `modeId` on the live build, so the level is only
    // real if this call was made.
    expect(probe.server()?.paramsFor('session/set_mode')).toMatchObject({ modeId: 'plan' });
    expect(opened.effectiveConfiguration.level).toBe('read-only');
  });

  it('refuses to open a session for a level ACP cannot express', async () => {
    const adapter = new CursorAcpAdapter();
    await expect(
      adapter.openSession({
        params: openParams({ configuration: { ...CONFIGURATION, level: 'full-access' } }),
        context: harness().context,
      })
    ).rejects.toThrow(/full-access/);
  });

  it('fails the open when the vendor rejects the mode', async () => {
    // Running `agent` after the user asked for `plan` would be a silent
    // permission escalation.
    const adapter = new CursorAcpAdapter();
    await expect(
      adapter.openSession({
        params: openParams({ configuration: { ...CONFIGURATION, level: 'read-only' } }),
        context: harness({ scenario: 'mode-rejected' }).context,
      })
    ).rejects.toThrow(/Invalid mode ID/);
  });

  it('loads a session when one is named and the build advertises it', async () => {
    const adapter = new CursorAcpAdapter();
    const probe = harness();
    const opened = await adapter.openSession({
      params: openParams({ resumeRef: 'prior-session', resumeMode: 'strict' }),
      context: probe.context,
    });

    expect(probe.server()?.called('session/load')).toBe(true);
    expect(opened).toMatchObject({ resumed: true, nativeSessionId: 'prior-session' });
  });

  it('starts fresh and says why when a fallback load fails', async () => {
    const adapter = new CursorAcpAdapter();
    const opened = await adapter.openSession({
      params: openParams({ resumeRef: 'gone', resumeMode: 'fallback' }),
      context: harness({ scenario: 'load-rejected' }).context,
    });

    expect(opened.resumed).toBe(false);
    expect(opened.fallbackReason).toBeDefined();
  });

  it('fails a strict load rather than handing back a different session', async () => {
    const adapter = new CursorAcpAdapter();
    await expect(
      adapter.openSession({
        params: openParams({ resumeRef: 'gone', resumeMode: 'strict' }),
        context: harness({ scenario: 'load-rejected' }).context,
      })
    ).rejects.toThrow(/could not load session/);
  });

  it('does not attempt a load a build never advertised', async () => {
    const adapter = new CursorAcpAdapter();
    const probe = harness({ scenario: 'no-load-session' });
    const opened = await adapter.openSession({
      params: openParams({ resumeRef: 'prior-session', resumeMode: 'fallback' }),
      context: probe.context,
    });

    expect(probe.server()?.called('session/load')).toBe(false);
    expect(opened.resumed).toBe(false);
  });

  it('lists native sessions off the open connection', async () => {
    const adapter = new CursorAcpAdapter();
    const probe = harness();
    await adapter.openSession({ params: openParams(), context: probe.context });

    const page = await adapter.listSessions({});
    expect(page.sessionIds).toEqual(['7e0059d1-e5a9-46cf-aba5-1261aaeb2324']);
  });

  it('will not guess which connection answers a listing', async () => {
    // One `cursor-agent` per session, each with its own cwd: asking whichever
    // opened first would answer about a workspace nobody named.
    const adapter = new CursorAcpAdapter();
    const probe = harness();
    await adapter.openSession({ params: openParams(), context: probe.context });
    await adapter.openSession({
      params: openParams({ sessionId: 'session-2' }),
      context: probe.context,
    });

    await expect(adapter.listSessions({})).rejects.toThrow(/more than one is open/);
    const page = await adapter.listSessions({ sessionId: 'session-2' });
    expect(page.sessionIds).toEqual(['7e0059d1-e5a9-46cf-aba5-1261aaeb2324']);
  });
});

describe('cursor adapter — turns', () => {
  it('streams the recorded turn and completes', async () => {
    const adapter = new CursorAcpAdapter();
    const probe = harness();
    await adapter.openSession({ params: openParams(), context: probe.context });

    const stream = adapter.startTurn({
      nativeSessionId: CURSOR_TRANSCRIPT.sessionId,
      params: turnParams(),
      context: probe.context,
    });
    const events = await collect(stream);

    expect(events.filter((event) => event.type === 'text_delta').length).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === 'reasoning_delta').length).toBeGreaterThan(0);
    expect(events.at(-1)).toEqual({ type: 'completed' });
  });

  it('ignores updates addressed to another session on the same connection', async () => {
    const adapter = new CursorAcpAdapter();
    const probe = harness({ scenario: 'unknown-additive' });
    await adapter.openSession({ params: openParams(), context: probe.context });

    const events = await collect(
      adapter.startTurn({
        nativeSessionId: CURSOR_TRANSCRIPT.sessionId,
        params: turnParams(),
        context: probe.context,
      })
    );

    const text = events
      .filter(
        (event): event is Extract<ExternalAgentEvent, { type: 'text_delta' }> =>
          event.type === 'text_delta'
      )
      .map((event) => event.text)
      .join('');
    expect(text).not.toContain('NOPE');
    expect(events.at(-1)).toEqual({ type: 'completed' });
  });

  it('reports a vendor-side stop as an error rather than a completion', async () => {
    const adapter = new CursorAcpAdapter();
    const probe = harness({ scenario: 'refusal' });
    await adapter.openSession({ params: openParams(), context: probe.context });

    const events = await collect(
      adapter.startTurn({
        nativeSessionId: CURSOR_TRANSCRIPT.sessionId,
        params: turnParams(),
        context: probe.context,
      })
    );

    expect(events.at(-1)).toMatchObject({ type: 'error', error: { vendorCode: 'refusal' } });
  });

  it('cancels through `session/cancel` and closes the stream', async () => {
    const adapter = new CursorAcpAdapter();
    const probe = harness({ promptDelayMs: 200 });
    await adapter.openSession({ params: openParams(), context: probe.context });

    const stream = adapter.startTurn({
      nativeSessionId: CURSOR_TRANSCRIPT.sessionId,
      params: turnParams(),
      context: probe.context,
    });
    const collecting = collect(stream);
    await Bun.sleep(20);
    await adapter.cancel({
      sessionId: 'session-1',
      nativeSessionId: CURSOR_TRANSCRIPT.sessionId,
      reason: 'requested',
    });

    const events = await collecting;
    expect(probe.server()?.called('session/cancel')).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });
});

describe('cursor adapter — approvals', () => {
  it('delivers the vendor option set unmodified and returns the choice verbatim', async () => {
    const adapter = new CursorAcpAdapter();
    const probe = harness({ scenario: 'permission' });
    await adapter.openSession({ params: openParams(), context: probe.context });

    const stream = adapter.startTurn({
      nativeSessionId: CURSOR_TRANSCRIPT.sessionId,
      params: turnParams(),
      context: probe.context,
    });
    const events: ExternalAgentEvent[] = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type !== 'approval_requested') continue;
      // The whole point of the round trip: nothing added, removed, reordered or
      // renamed on the way out.
      expect(event.request.options.map((option) => option.id)).toEqual([
        'allow-once',
        'allow-always',
        'reject-once',
      ]);
      expect(event.request.options.map((option) => option.rawLabel)).toEqual([
        'Allow once',
        'Allow always',
        'Reject',
      ]);
      expect(event.request.options.map((option) => option.isDestructive)).toEqual([
        false,
        true,
        false,
      ]);
      await adapter.respond({
        sessionId: 'session-1',
        nativeSessionId: CURSOR_TRANSCRIPT.sessionId,
        nativeTurnId: 'msg-1',
        requestId: event.request.requestId,
        optionId: 'allow-always',
      });
    }

    const answered = [...(probe.server()?.answers.values() ?? [])];
    expect(answered).toContainEqual({ outcome: { outcome: 'selected', optionId: 'allow-always' } });
    expect(events.some((event) => event.type === 'approval_resolved')).toBe(true);
    // Cursor numbers its requests from zero and matches on the id it sent, so
    // a stringified echo blocks the vendor forever on a question it already
    // has the answer to.
    expect(probe.server()?.idMismatches).toEqual([]);
  });

  it('never answers a permission request on its own', async () => {
    // The ownership-inversion guard. Nothing but `respond` may produce
    // `selected`; a turn nobody answers ends with `cancelled` instead.
    const adapter = new CursorAcpAdapter();
    const probe = harness({ scenario: 'permission' });
    await adapter.openSession({ params: openParams(), context: probe.context });

    const stream = adapter.startTurn({
      nativeSessionId: CURSOR_TRANSCRIPT.sessionId,
      params: turnParams(),
      context: probe.context,
    });
    const iterator = stream[Symbol.asyncIterator]();
    let request: ExternalAgentEvent | undefined;
    while (!request) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === 'approval_requested') request = next.value;
    }
    expect(request).toBeDefined();

    await adapter.cancel({
      sessionId: 'session-1',
      nativeSessionId: CURSOR_TRANSCRIPT.sessionId,
      reason: 'requested',
    });
    await Bun.sleep(20);

    const answered = [...(probe.server()?.answers.values() ?? [])];
    expect(answered).toEqual([{ outcome: { outcome: 'cancelled' } }]);
  });

  it('refuses an option-less request rather than blocking the turn on nothing', async () => {
    const adapter = new CursorAcpAdapter();
    const probe = harness({ scenario: 'permission-no-options' });
    await adapter.openSession({ params: openParams(), context: probe.context });

    await collect(
      adapter.startTurn({
        nativeSessionId: CURSOR_TRANSCRIPT.sessionId,
        params: turnParams(),
        context: probe.context,
      })
    );

    const answered = [...(probe.server()?.answers.values() ?? [])];
    expect(answered[0]).toMatchObject({ code: -32600 });
  });

  it('refuses to touch the machine on the agent behalf', async () => {
    // `fs/*` and `terminal/*` are ACP asking the client to act. This client
    // advertises none of those capabilities, and the refusal is what makes that
    // advertisement true.
    const adapter = new CursorAcpAdapter();
    const probe = harness({ scenario: 'host-tool-call' });
    await adapter.openSession({ params: openParams(), context: probe.context });

    await collect(
      adapter.startTurn({
        nativeSessionId: CURSOR_TRANSCRIPT.sessionId,
        params: turnParams(),
        context: probe.context,
      })
    );

    const answered = [...(probe.server()?.answers.values() ?? [])];
    expect(answered[0]).toMatchObject({ code: -32601 });
    expect(JSON.stringify(answered[0])).toContain('External agents use their own tools');
  });
});
