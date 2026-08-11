import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { ExternalAgentEvent } from '@mangostudio/shared/external-agents';
import type {
  ExternalAgentAdapterContext,
  ExternalAgentAdapterSpawnOptions,
} from '../../../src/services/external-agents/adapter';
import { CodexAppServerAdapter } from '../../../src/services/external-agents/codex/adapter';
import type { ExternalAgentManagedProcess } from '../../../src/services/external-agents/process';
import { TURN_ID } from '../../support/codex-fixtures';
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

    expect(descriptor).toMatchObject({ installed: true, version: 'codex-cli 0.140.0' });
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
