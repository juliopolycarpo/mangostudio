import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { ExternalAgentEvent } from '@mangostudio/shared/external-agents';
import type {
  ExternalAgentAdapterContext,
  ExternalAgentAdapterSpawnOptions,
} from '../../../src/services/external-agents/adapter';
import { CodexAppServerAdapter } from '../../../src/services/external-agents/codex/adapter';
import { MINIMUM_CODEX_VERSION } from '../../../src/services/external-agents/codex/pinned';
import type { ExternalAgentManagedProcess } from '../../../src/services/external-agents/process';
import { THREAD_ID, TURN_ID } from '../../support/codex-fixtures';
import {
  createFakeCodexProcess,
  type FakeCodexOptions,
  type FakeCodexServer,
} from '../../support/fake-codex-app-server';

interface Harness {
  readonly context: ExternalAgentAdapterContext;
  readonly server: () => FakeCodexServer | undefined;
  readonly controller: AbortController;
}

/**
 * Everything the supervisor would provide, minus the supervisor.
 *
 * `spawn` answers `--version` with a banner process and `app-server` with the
 * fake vendor, which is exactly the branch the adapter takes: it reads the
 * version off the resolved executable before it launches anything, because
 * `initialize` carries no protocol version to gate on.
 */
function harness(options: FakeCodexOptions & { readonly banner?: string } = {}): Harness {
  const controller = new AbortController();
  let server: FakeCodexServer | undefined;
  const banner = options.banner ?? 'codex-cli 0.147.0';

  const context: ExternalAgentAdapterContext = {
    signal: controller.signal,
    executablePath: '/usr/local/bin/codex',
    cwd: '/workspace',
    environment: {},
    spawn: (spawnOptions: ExternalAgentAdapterSpawnOptions): ExternalAgentManagedProcess => {
      if (spawnOptions.argv.includes('--version')) return versionProcess(banner);
      const fake = createFakeCodexProcess(options);
      server = fake.server;
      return fake.managed;
    },
  };
  return { context, server: () => server, controller };
}

function versionProcess(banner: string): ExternalAgentManagedProcess {
  let read = false;
  return {
    pid: -1,
    stdout: {
      next: () => {
        if (read) return Promise.resolve({ kind: 'eof' } as const);
        read = true;
        return Promise.resolve({ kind: 'line', line: banner } as const);
      },
      close: () => undefined,
    },
    exit: Promise.resolve({ code: 0, signal: null }),
    writeLine: () => Promise.resolve(),
    endInput: () => undefined,
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
    targetId: 'codex' as const,
    workspacePath: '/workspace',
    configuration: { ...CONFIGURATION },
    resumeMode: 'fallback' as const,
    timeoutMs: 5_000,
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<ExternalAgentEvent>): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('codex adapter — discovery', () => {
  it('reports the version, a minimal account label and the full 2 x 3 matrix', async () => {
    const adapter = new CodexAppServerAdapter();
    const descriptor = await adapter.discover(harness().context);

    expect(descriptor).toMatchObject({
      targetId: 'codex',
      installed: true,
      version: 'codex-cli 0.147.0',
      authState: 'signed-in',
    });
    expect(descriptor.supportedConfigurations).toHaveLength(6);
    expect(descriptor.supportedConfigurations.every((entry) => entry.supported)).toBe(true);
    expect(descriptor.models?.[0]).toMatchObject({ id: 'gpt-5.6-sol', isDefault: true });
  });

  it('never returns the raw email, and fingerprints it under a host-local key', async () => {
    const adapter = new CodexAppServerAdapter();
    const descriptor = await adapter.discover(harness().context);

    expect(JSON.stringify(descriptor)).not.toContain('someone@example.com');
    expect(descriptor.account).toMatchObject({ label: 'ChatGPT', planType: 'plus' });
    expect(descriptor.account?.fingerprint).toMatch(/^[0-9a-f]{32}$/);

    // An email is not enough entropy to hash: an unkeyed digest is reproducible
    // by anyone holding the descriptor and a guess, which is the personal data
    // the label was meant to keep on this machine.
    const unkeyed = createHash('sha256')
      .update('codex:someone@example.com')
      .digest('hex')
      .slice(0, 32);
    expect(descriptor.account?.fingerprint).not.toBe(unkeyed);
  });

  it('reports a disallowed profile as a policy refusal, not a MangoStudio limitation', async () => {
    const adapter = new CodexAppServerAdapter();
    const descriptor = await adapter.discover(harness({ scenario: 'profile-disallowed' }).context);

    const fullAccess = descriptor.supportedConfigurations.filter(
      (entry) => entry.level === 'full-access'
    );
    expect(fullAccess).toHaveLength(2);
    for (const entry of fullAccess) {
      expect(entry.supported).toBe(false);
      expect(entry.unsupportedReasonKey).toBe('externalAgents.unsupported.codexProfileDisallowed');
      expect(entry.vendorId).toBe(':danger-full-access');
    }
    expect(
      descriptor.supportedConfigurations
        .filter((entry) => entry.level !== 'full-access')
        .every((entry) => entry.supported)
    ).toBe(true);
  });

  it('reports not installed when no executable resolved', async () => {
    const adapter = new CodexAppServerAdapter();
    const { context } = harness();
    const descriptor = await adapter.discover({ ...context, executablePath: undefined });

    expect(descriptor).toMatchObject({ installed: false, loginCommand: 'codex login' });
    expect(descriptor.supportedConfigurations).toEqual([]);
  });

  it('offers nothing selectable for a Codex too old to open a session', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness({ banner: 'codex-cli 0.140.0' });
    const descriptor = await adapter.discover(test.context);

    expect(descriptor).toMatchObject({
      installed: true,
      version: 'codex-cli 0.140.0',
      // Codex is the one vendor still gated on the number, so it is also the
      // one that has to say which number would clear it.
      unavailableReason: 'version-unsupported',
      requiredVersion: MINIMUM_CODEX_VERSION,
    });
    expect(descriptor.supportedConfigurations).toHaveLength(6);
    for (const entry of descriptor.supportedConfigurations) {
      expect(entry.supported).toBe(false);
      expect(entry.unsupportedReasonKey).toBe('externalAgents.unsupported.codexVersionTooOld');
    }
    // The selector cannot offer what `openSession` would refuse, and no
    // `app-server` was launched to find that out.
    expect(descriptor.capabilities.interactiveApprovals).toBe(false);
    expect(test.server()).toBeUndefined();
  });

  it('walks the model catalog past its first page', async () => {
    const adapter = new CodexAppServerAdapter();
    const descriptor = await adapter.discover(harness({ modelPages: 3 }).context);

    expect(descriptor.models?.map((model) => model.id)).toEqual([
      'gpt-5.6-sol',
      'model-page-1',
      'model-page-2',
    ]);
  });
});

describe('codex adapter — sessions', () => {
  it('sends the kebab-case sandbox STRING to thread/start', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness();
    await adapter.openSession({ params: openParams(), context: test.context });

    const start = test.server()?.calls.find((call) => call.method === 'thread/start');
    expect(start?.params).toMatchObject({
      cwd: '/workspace',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    });
  });

  it('returns the thread/start echo as effectiveConfiguration, not the request', async () => {
    const adapter = new CodexAppServerAdapter();
    const opened = await adapter.openSession({
      params: openParams({
        configuration: { ...CONFIGURATION, model: 'gpt-5.6-sol', effort: 'low' },
      }),
      context: harness({ scenario: 'config-override' }).context,
    });

    expect(opened.effectiveConfiguration).toMatchObject({
      model: 'gpt-5.6-overridden',
      effort: 'high',
    });
    expect(opened.resumed).toBe(false);
  });

  it('clears an effort Codex did not apply instead of echoing the request back', async () => {
    const adapter = new CodexAppServerAdapter();
    // The default fixture echoes `reasoningEffort: null` — a model that applies
    // no reasoning effort — while the request asked for one.
    const opened = await adapter.openSession({
      params: openParams({ configuration: { ...CONFIGURATION, effort: 'high' } }),
      context: harness().context,
    });

    expect(opened.effectiveConfiguration.effort).toBeUndefined();
    expect('effort' in opened.effectiveConfiguration).toBe(false);
  });

  it('falls back to a fresh thread and says why when resume is rejected', async () => {
    const adapter = new CodexAppServerAdapter();
    const opened = await adapter.openSession({
      params: openParams({ resumeRef: 'gone-thread', resumeMode: 'fallback' }),
      context: harness({ scenario: 'resume-rejected' }).context,
    });

    expect(opened.resumed).toBe(false);
    expect(opened.fallbackReason).toContain('thread not found');
  });

  it('fails a strict resume rather than silently adopting a different session', async () => {
    const adapter = new CodexAppServerAdapter();
    await expect(
      adapter.openSession({
        params: openParams({ resumeRef: 'gone-thread', resumeMode: 'strict' }),
        context: harness({ scenario: 'resume-rejected' }).context,
      })
    ).rejects.toThrow(/could not resume thread "gone-thread"/);
  });

  it('refuses to open against a Codex older than the pinned minimum', async () => {
    const adapter = new CodexAppServerAdapter();
    await expect(
      adapter.openSession({
        params: openParams(),
        context: harness({ banner: 'codex-cli 0.140.0' }).context,
      })
    ).rejects.toThrow(/predates the 0\.147\.0/);
  });

  it('accepts a newer Codex than the pin', async () => {
    const adapter = new CodexAppServerAdapter();
    const opened = await adapter.openSession({
      params: openParams(),
      context: harness({ banner: 'codex-cli 0.190.3' }).context,
    });
    expect(opened.nativeSessionId).toBeTruthy();
  });
});

describe('codex adapter — turns', () => {
  it('streams a text turn as deltas, drops the user echo, and reports per-turn usage', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness();
    await adapter.openSession({ params: openParams(), context: test.context });
    const stream = adapter.startTurn({
      nativeSessionId: 'thread',
      params: {
        sessionId: 'session-1',
        clientMessageId: 'message-1',
        input: 'hello',
        configuration: { ...CONFIGURATION },
      },
      context: test.context,
    });

    expect(stream.nativeTurnId).toBe('message-1');
    const events = await collect(stream);

    expect(events).toEqual([
      { type: 'text_delta', text: 'MANGO' },
      { type: 'text_delta', text: '_OK' },
      {
        type: 'usage',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
          reasoningTokens: 3,
          totalTokens: 120,
        },
      },
      {
        type: 'thread_usage',
        usage: {
          last: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
            reasoningTokens: 3,
            totalTokens: 120,
          },
          total: {
            inputTokens: 21_424,
            outputTokens: 7,
            cacheReadTokens: 6_912,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            totalTokens: 21_431,
          },
        },
      },
      { type: 'completed' },
    ]);
  });

  it('sends the camelCase sandboxPolicy OBJECT to turn/start with the workdir writable', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness();
    await adapter.openSession({ params: openParams(), context: test.context });
    await collect(
      adapter.startTurn({
        nativeSessionId: 'thread',
        params: {
          sessionId: 'session-1',
          clientMessageId: 'message-1',
          input: 'hello',
          configuration: { ...CONFIGURATION },
        },
        context: test.context,
      })
    );

    const turn = test.server()?.calls.find((call) => call.method === 'turn/start');
    expect(turn?.params).toMatchObject({
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/workspace'],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    });
  });

  it('streams reasoning on its own event type, never inside the message deltas', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness({ scenario: 'reasoning' });
    await adapter.openSession({ params: openParams(), context: test.context });
    const events = await collect(
      adapter.startTurn({
        nativeSessionId: 'thread',
        params: {
          sessionId: 'session-1',
          clientMessageId: 'message-1',
          input: 'hello',
          configuration: { ...CONFIGURATION },
        },
        context: test.context,
      })
    );

    expect(events.filter((event) => event.type === 'reasoning_delta')).toEqual([
      { type: 'reasoning_delta', text: 'Considering' },
    ]);
    expect(
      events.filter((event) => event.type === 'text_delta').map((event) => event.text)
    ).toEqual(['MANGO', '_OK']);
  });

  it('ignores additive notification and item types instead of failing the turn', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness({ scenario: 'unknown-additive' });
    await adapter.openSession({ params: openParams(), context: test.context });
    const events = await collect(
      adapter.startTurn({
        nativeSessionId: 'thread',
        params: {
          sessionId: 'session-1',
          clientMessageId: 'message-1',
          input: 'hello',
          configuration: { ...CONFIGURATION },
        },
        context: test.context,
      })
    );

    expect(events.at(-1)).toEqual({ type: 'completed' });
    const activity = events.filter((event) => event.type === 'activity_started');
    expect(activity).toEqual([
      {
        type: 'activity_started',
        callId: 'item-future',
        activity: { name: 'quantumTool', kind: 'other', title: 'quantumTool' },
      },
    ]);
  });

  it('surfaces a vendor error with its code preserved rather than flattened', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness({ scenario: 'error' });
    await adapter.openSession({ params: openParams(), context: test.context });
    const events = await collect(
      adapter.startTurn({
        nativeSessionId: 'thread',
        params: {
          sessionId: 'session-1',
          clientMessageId: 'message-1',
          input: 'hello',
          configuration: { ...CONFIGURATION },
        },
        context: test.context,
      })
    );

    expect(events).toMatchObject([
      {
        type: 'error',
        error: {
          code: 'vendor-error',
          message: 'Usage limit reached',
          vendorCode: 'usageLimitExceeded',
        },
      },
      { type: 'error', error: { code: 'vendor-turn-failed' } },
    ]);
  });

  it('ends the stream when the turn is cancelled', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness({ scenario: 'command-approval' });
    await adapter.openSession({ params: openParams(), context: test.context });
    const stream = adapter.startTurn({
      nativeSessionId: 'thread',
      params: {
        sessionId: 'session-1',
        clientMessageId: 'message-1',
        input: 'hello',
        configuration: { ...CONFIGURATION },
      },
      context: test.context,
    });

    const events: ExternalAgentEvent[] = [];
    const drain = (async () => {
      for await (const event of stream) {
        events.push(event);
        if (event.type === 'approval_requested') {
          await adapter.cancel({
            sessionId: 'session-1',
            nativeTurnId: 'message-1',
            nativeSessionId: 'thread',
            reason: 'requested',
          });
        }
      }
    })();

    await drain;
    expect(events.at(-1)?.type).toBe('approval_requested');
    // The blocked server request was answered, so the vendor is not left
    // waiting on a reply for a turn that no longer exists.
    expect([...(test.server()?.answers.values() ?? [])]).toMatchObject([
      { code: -32800, message: 'The turn was cancelled.' },
    ]);
  });
});

describe('codex adapter — cancelling before Codex names the turn', () => {
  it('still interrupts the vendor turn once its id arrives', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness({ turnStartDelayMs: 40 });
    await adapter.openSession({ params: openParams(), context: test.context });

    const stream = adapter.startTurn({
      nativeSessionId: 'thread',
      params: {
        sessionId: 'session-1',
        clientMessageId: 'message-1',
        input: 'hello',
        configuration: { ...CONFIGURATION },
      },
      context: test.context,
    });

    // Cancel lands while `turn/start` is still in flight: Codex has accepted the
    // turn and nothing here knows what it called it.
    await adapter.cancel({
      sessionId: 'session-1',
      nativeSessionId: 'thread',
      nativeTurnId: 'message-1',
      reason: 'requested',
    });
    expect(await collect(stream)).toEqual([]);
    expect(test.server()?.called('turn/interrupt')).toBe(false);

    // …and once the id arrives, the interrupt the cancel could not send is sent.
    await Bun.sleep(120);
    const interrupt = test.server()?.calls.find((call) => call.method === 'turn/interrupt');
    expect(interrupt?.params).toMatchObject({ turnId: TURN_ID });
  });
});

describe('codex adapter — steering', () => {
  /**
   * `pauseBeforeCompletion` holds the turn active with nothing outstanding on
   * the wire, which is what a steer needs: the shared JSON-RPC client answers
   * one message at a time and does not read past a server→client request
   * until it is answered, so a turn parked on an approval (`command-approval`)
   * can never see a `turn/steer` response either — see the adapter's own
   * `session.approvals.size > 0` guard, covered separately below.
   */
  async function openPausedTurn(adapter: CodexAppServerAdapter, test: Harness) {
    await adapter.openSession({ params: openParams(), context: test.context });
    const stream = adapter.startTurn({
      nativeSessionId: 'thread',
      params: {
        sessionId: 'session-1',
        clientMessageId: 'message-1',
        input: 'hello',
        configuration: { ...CONFIGURATION },
      },
      context: test.context,
    });
    // `turn/start`'s response names the turn on a microtask this test has no
    // event to wait on for — the fixture is paused before anything else is
    // notified — so this is a deliberate, generous margin rather than a poll.
    await Bun.sleep(20);
    return stream;
  }

  it("sends turn/steer with expectedTurnId and tracks Codex's continuation id", async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness({ pauseBeforeCompletion: true });
    const stream = await openPausedTurn(adapter, test);

    test.server()?.setSteerBehavior('accepted', 'continued-turn-id');
    const outcome = await adapter.steer({
      sessionId: 'session-1',
      nativeSessionId: 'thread',
      nativeTurnId: 'message-1',
      clientMessageId: 'steer-1',
      input: 'actually use the existing helper',
    });
    expect(outcome).toEqual({ accepted: true });

    const steer = test.server()?.calls.find((call) => call.method === 'turn/steer');
    expect(steer?.params).toEqual({
      threadId: THREAD_ID,
      expectedTurnId: TURN_ID,
      clientUserMessageId: 'steer-1',
      input: [{ type: 'text', text: 'actually use the existing helper', text_elements: [] }],
    });

    // Codex's own continuation id, not the hub's handle — a later interrupt
    // has to address the turn Codex is actually running now.
    await adapter.cancel({
      sessionId: 'session-1',
      nativeSessionId: 'thread',
      nativeTurnId: 'message-1',
      reason: 'requested',
    });
    expect(await collect(stream)).toEqual([]);
    const interrupt = test.server()?.calls.find((call) => call.method === 'turn/interrupt');
    expect(interrupt?.params).toMatchObject({ turnId: 'continued-turn-id' });
  });

  it("serializes concurrent steers so the second addresses the first's continuation id", async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness({ pauseBeforeCompletion: true });
    const stream = await openPausedTurn(adapter, test);

    test.server()?.setSteerBehavior('accepted', 'continuation-1');
    // Neither is awaited before the other starts: both read `activeTurn` while
    // the first is still in flight, which is exactly the race that let the
    // second address a turn id Codex had already moved past.
    const first = adapter.steer({
      sessionId: 'session-1',
      nativeSessionId: 'thread',
      nativeTurnId: 'message-1',
      clientMessageId: 'steer-1',
      input: 'first correction',
    });
    const second = adapter.steer({
      sessionId: 'session-1',
      nativeSessionId: 'thread',
      nativeTurnId: 'message-1',
      clientMessageId: 'steer-2',
      input: 'second correction',
    });

    expect(await first).toEqual({ accepted: true });
    expect(await second).toEqual({ accepted: true });

    const steers = test.server()?.calls.filter((call) => call.method === 'turn/steer') ?? [];
    expect(steers).toHaveLength(2);
    expect(steers[0]?.params).toMatchObject({
      expectedTurnId: TURN_ID,
      clientUserMessageId: 'steer-1',
    });
    // Serialized: the second is not sent until the first resolved and updated
    // the turn id Codex is actually running, so it addresses that id — not
    // the stale one that was live when both calls were made.
    expect(steers[1]?.params).toMatchObject({
      expectedTurnId: 'continuation-1',
      clientUserMessageId: 'steer-2',
    });

    await adapter.cancel({
      sessionId: 'session-1',
      nativeSessionId: 'thread',
      nativeTurnId: 'message-1',
      reason: 'requested',
    });
    expect(await collect(stream)).toEqual([]);
  });

  it('maps a structured activeTurnNotSteerable refusal to turn-not-steerable', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness({ pauseBeforeCompletion: true });
    const stream = await openPausedTurn(adapter, test);

    test.server()?.setSteerBehavior('not-steerable');
    const outcome = await adapter.steer({
      sessionId: 'session-1',
      nativeSessionId: 'thread',
      nativeTurnId: 'message-1',
      clientMessageId: 'steer-1',
      input: 'switch to plan mode',
    });
    expect(outcome).toEqual({ accepted: false, reasonCode: 'turn-not-steerable' });

    await adapter.cancel({
      sessionId: 'session-1',
      nativeSessionId: 'thread',
      nativeTurnId: 'message-1',
      reason: 'requested',
    });
    expect(await collect(stream)).toEqual([]);
  });

  it('re-throws an unstructured steer failure rather than guessing a reason', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness({ pauseBeforeCompletion: true });
    const stream = await openPausedTurn(adapter, test);

    test.server()?.setSteerBehavior('unknown-error');
    await expect(
      adapter.steer({
        sessionId: 'session-1',
        nativeSessionId: 'thread',
        nativeTurnId: 'message-1',
        clientMessageId: 'steer-1',
        input: 'hello?',
      })
    ).rejects.toThrow('something else went wrong');

    await adapter.cancel({
      sessionId: 'session-1',
      nativeSessionId: 'thread',
      nativeTurnId: 'message-1',
      reason: 'requested',
    });
    expect(await collect(stream)).toEqual([]);
  });

  it('refuses locally, without a round trip, while an approval is outstanding', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness({ scenario: 'command-approval' });
    await adapter.openSession({ params: openParams(), context: test.context });
    const stream = adapter.startTurn({
      nativeSessionId: 'thread',
      params: {
        sessionId: 'session-1',
        clientMessageId: 'message-1',
        input: 'hello',
        configuration: { ...CONFIGURATION },
      },
      context: test.context,
    });

    for await (const event of stream) {
      if (event.type !== 'approval_requested') continue;
      // A `turn/steer` sent now could never see its response: the shared
      // JSON-RPC client will not read past this unanswered server request.
      // Refused locally is what keeps this fast instead of a 30s timeout.
      const outcome = await adapter.steer({
        sessionId: 'session-1',
        nativeSessionId: 'thread',
        nativeTurnId: 'message-1',
        clientMessageId: 'steer-1',
        input: 'hello?',
      });
      expect(outcome).toEqual({ accepted: false, reasonCode: 'turn-not-steerable' });
      expect(test.server()?.called('turn/steer')).toBe(false);

      await adapter.respond({
        sessionId: 'session-1',
        nativeSessionId: 'thread',
        nativeTurnId: 'message-1',
        requestId: event.request.requestId,
        optionId: 'accept',
      });
    }
  });

  it('refuses locally, without a round trip, when the handle does not name the active turn', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness();
    await adapter.openSession({ params: openParams(), context: test.context });
    const stream = adapter.startTurn({
      nativeSessionId: 'thread',
      params: {
        sessionId: 'session-1',
        clientMessageId: 'message-1',
        input: 'hello',
        configuration: { ...CONFIGURATION },
      },
      context: test.context,
    });
    // Drained to completion: no active turn is left to steer.
    await collect(stream);

    const outcome = await adapter.steer({
      sessionId: 'session-1',
      nativeSessionId: 'thread',
      nativeTurnId: 'message-1',
      clientMessageId: 'steer-1',
      input: 'too late',
    });

    expect(outcome).toEqual({ accepted: false, reasonCode: 'turn-already-completed' });
    expect(test.server()?.called('turn/steer')).toBe(false);
  });

  it('refuses a handle that does not match the currently active turn', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness({ scenario: 'command-approval' });
    await adapter.openSession({ params: openParams(), context: test.context });
    const stream = adapter.startTurn({
      nativeSessionId: 'thread',
      params: {
        sessionId: 'session-1',
        clientMessageId: 'message-1',
        input: 'hello',
        configuration: { ...CONFIGURATION },
      },
      context: test.context,
    });

    for await (const event of stream) {
      if (event.type !== 'approval_requested') continue;
      const outcome = await adapter.steer({
        sessionId: 'session-1',
        nativeSessionId: 'thread',
        nativeTurnId: 'a-different-turn',
        clientMessageId: 'steer-1',
        input: 'hello?',
      });
      expect(outcome).toEqual({ accepted: false, reasonCode: 'turn-already-completed' });
      expect(test.server()?.called('turn/steer')).toBe(false);

      await adapter.respond({
        sessionId: 'session-1',
        nativeSessionId: 'thread',
        nativeTurnId: 'message-1',
        requestId: event.request.requestId,
        optionId: 'accept',
      });
    }
  });
});

describe('codex adapter — approvals', () => {
  it('surfaces a command approval with the vendor decision set and answers it', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness({ scenario: 'command-approval' });
    await adapter.openSession({ params: openParams(), context: test.context });
    const stream = adapter.startTurn({
      nativeSessionId: 'thread',
      params: {
        sessionId: 'session-1',
        clientMessageId: 'message-1',
        input: 'hello',
        configuration: { ...CONFIGURATION },
      },
      context: test.context,
    });

    const events: ExternalAgentEvent[] = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === 'approval_requested') {
        expect(event.request.kind).toBe('command');
        expect(event.request.title).toBe('rm -rf build');
        expect(event.request.options.map((option) => option.id)).toEqual([
          'accept',
          'acceptForSession',
          'decline',
          'cancel',
        ]);
        expect(event.request.expiresAtMs).toBeGreaterThan(Date.now());
        await adapter.respond({
          sessionId: 'session-1',
          nativeSessionId: 'thread',
          nativeTurnId: 'message-1',
          requestId: event.request.requestId,
          optionId: 'accept',
        });
      }
    }

    expect([...(test.server()?.answers.values() ?? [])]).toEqual([{ decision: 'accept' }]);
    expect(events.some((event) => event.type === 'approval_resolved')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'completed' });
  });

  it('answers a file-change approval with the vendor decision enum', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness({ scenario: 'file-approval' });
    await adapter.openSession({ params: openParams(), context: test.context });
    const stream = adapter.startTurn({
      nativeSessionId: 'thread',
      params: {
        sessionId: 'session-1',
        clientMessageId: 'message-1',
        input: 'hello',
        configuration: { ...CONFIGURATION },
      },
      context: test.context,
    });

    for await (const event of stream) {
      if (event.type !== 'approval_requested') continue;
      expect(event.request.kind).toBe('file-change');
      await adapter.respond({
        sessionId: 'session-1',
        nativeSessionId: 'thread',
        nativeTurnId: 'message-1',
        requestId: event.request.requestId,
        optionId: 'decline',
      });
    }

    expect([...(test.server()?.answers.values() ?? [])]).toEqual([{ decision: 'decline' }]);
  });

  it('refuses an answer that arrives after the approval expired', async () => {
    // A clock the test drives, so the deadline is crossed rather than waited out.
    let now = Date.now();
    const adapter = new CodexAppServerAdapter({ now: () => now });
    const test = harness({ scenario: 'command-approval' });
    await adapter.openSession({ params: openParams(), context: test.context });
    const stream = adapter.startTurn({
      nativeSessionId: 'thread',
      params: {
        sessionId: 'session-1',
        clientMessageId: 'message-1',
        input: 'hello',
        configuration: { ...CONFIGURATION },
      },
      context: test.context,
    });

    const events: ExternalAgentEvent[] = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type !== 'approval_requested') continue;
      now = event.request.expiresAtMs + 1;
      await expect(
        adapter.respond({
          sessionId: 'session-1',
          nativeSessionId: 'thread',
          nativeTurnId: 'message-1',
          requestId: event.request.requestId,
          optionId: 'accept',
        })
      ).rejects.toThrow(/expired before this answer arrived/);
    }

    // The action was not granted, and the vendor is not left blocked either.
    expect([...(test.server()?.answers.values() ?? [])]).toMatchObject([{ code: -32800 }]);
    expect(
      events.some(
        (event) => event.type === 'approval_resolved' && event.decision.source === 'expired'
      )
    ).toBe(true);
  });

  it('rejects an option Codex never offered without leaving the vendor blocked', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness({ scenario: 'command-approval' });
    await adapter.openSession({ params: openParams(), context: test.context });
    const stream = adapter.startTurn({
      nativeSessionId: 'thread',
      params: {
        sessionId: 'session-1',
        clientMessageId: 'message-1',
        input: 'hello',
        configuration: { ...CONFIGURATION },
      },
      context: test.context,
    });

    for await (const event of stream) {
      if (event.type !== 'approval_requested') continue;
      await expect(
        adapter.respond({
          sessionId: 'session-1',
          nativeSessionId: 'thread',
          nativeTurnId: 'message-1',
          requestId: event.request.requestId,
          optionId: 'acceptWithExecpolicyAmendment',
        })
      ).rejects.toThrow(/not an option Codex offered/);
    }

    expect([...(test.server()?.answers.values() ?? [])]).toMatchObject([{ code: -32602 }]);
  });
});

describe('codex adapter — the host-tool invariant', () => {
  it('refuses item/tool/call with a JSON-RPC error and dispatches nothing', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness({ scenario: 'host-tool-call' });
    await adapter.openSession({ params: openParams(), context: test.context });
    const events = await collect(
      adapter.startTurn({
        nativeSessionId: 'thread',
        params: {
          sessionId: 'session-1',
          clientMessageId: 'message-1',
          input: 'hello',
          configuration: { ...CONFIGURATION },
        },
        context: test.context,
      })
    );

    // Answered, and answered with an error.
    expect([...(test.server()?.answers.values() ?? [])]).toMatchObject([
      { code: -32601, message: expect.stringContaining('does not execute tools on its behalf') },
    ]);
    // Nothing executable reached the stream: no approval was ever offered for
    // it, so no user could have allowed it either.
    expect(events.some((event) => event.type === 'approval_requested')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'completed' });
  });
});

describe('codex adapter — native session listing', () => {
  it('adopts Thread.id and never Thread.sessionId', async () => {
    // The single easiest mistake in this mapping: both fields are required on
    // `Thread`, and `sessionId` is the one that *looks* right. `thread/resume`
    // takes the thread id, so mapping the other one adopts nothing.
    const adapter = new CodexAppServerAdapter();
    const test = harness();

    const page = await adapter.listSessions({ context: test.context });
    const ids = page.sessions.map((session) => session.nativeSessionId);
    expect(ids).toEqual([
      '019fe6d2-aaaa-7420-b12c-000000000001',
      '019fe6d2-bbbb-7420-b12c-000000000002',
    ]);
    expect(ids.some((id) => id.startsWith('session-tree'))).toBe(false);
  });

  it('falls back to the preview when the thread has no name', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness();

    const [named, unnamed] = (await adapter.listSessions({ context: test.context })).sessions;
    expect(named?.title).toBe('Fix the flaky test');
    expect(unnamed?.title).toBeUndefined();
    expect(unnamed?.preview).toBe('add a migration for the lease table');
  });

  it('converts Unix seconds to milliseconds exactly once', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness();

    const [withRecency, withoutRecency] = (await adapter.listSessions({ context: test.context }))
      .sessions;
    // `recencyAt` is what the listing is sorted by, so it is what the age shows.
    expect(withRecency?.updatedAtMs).toBe(1_786_284_100_000);
    // Null `recencyAt` falls back to `updatedAt` rather than dropping the row.
    expect(withoutRecency?.updatedAtMs).toBe(1_786_283_000_000);
  });

  it('reports no message count, because a listed thread carries no turns', async () => {
    // `turns` is documented as empty at list time and there is no
    // `messageCount` field. Nothing may invent one from the empty array.
    const adapter = new CodexAppServerAdapter();
    const test = harness();

    const page = await adapter.listSessions({ context: test.context });
    for (const session of page.sessions) {
      expect(Object.keys(session).some((key) => key.toLowerCase().includes('count'))).toBe(false);
    }
  });

  it('excludes ephemeral threads and subagent threads', async () => {
    const adapter = new CodexAppServerAdapter();
    const test = harness();

    const ids = (await adapter.listSessions({ context: test.context })).sessions.map(
      (session) => session.nativeSessionId
    );
    expect(ids).not.toContain('019fe6d2-cccc-7420-b12c-000000000003');
    expect(ids).not.toContain('019fe6d2-dddd-7420-b12c-000000000004');
  });

  it('asks for an explicit source allowlist, sort and bound', async () => {
    // Every one of these is stated rather than left to a server default: an
    // unfiltered listing mixes Codex's own subagent, review and compaction
    // threads in with the user's, and the documented default sort is by
    // creation rather than by recency.
    const adapter = new CodexAppServerAdapter();
    const test = harness();
    await adapter.listSessions({ context: test.context, workspacePath: '/workspace', limit: 10 });

    const call = test.server()?.calls.find((entry) => entry.method === 'thread/list');
    expect(call?.params).toMatchObject({
      sortKey: 'recency_at',
      sortDirection: 'desc',
      sourceKinds: ['cli', 'exec', 'appServer'],
      archived: false,
      cwd: '/workspace',
      limit: 10,
    });
  });

  it('lists without an open session', async () => {
    // The picker is rendered before any chat exists, so listing opens its own
    // short-lived app-server exactly as discovery does.
    const adapter = new CodexAppServerAdapter();
    const test = harness();

    const page = await adapter.listSessions({ context: test.context });
    expect(page.sessions.length).toBeGreaterThan(0);
  });
});
