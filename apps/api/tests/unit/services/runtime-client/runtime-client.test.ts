import { describe, expect, it } from 'bun:test';
import { PathAccessError, RuntimeConsentDeniedError } from '@mangostudio/runtime';
import {
  RUNTIME_CONSENT_PRESETS,
  type RuntimeCapabilityAllow,
} from '@mangostudio/shared/runtime-home';
import { ToolExecutionTimedOutError } from '../../../../src/services/tools/execution-timeout';
import { connectTestRuntime, TEST_RUNTIME_MANIFEST } from '../../../support/runtime-fixture';

/** A consent source that grants everything but `shell`, like `setup --profile readonly`. */
function withoutShell(): RuntimeCapabilityAllow {
  return { ...RUNTIME_CONSENT_PRESETS.full, shell: false };
}

describe('RuntimeClient', () => {
  it('routes the complete external-agent facade through the typed request multiplexer', async () => {
    const received: [string, unknown][] = [];
    const record =
      (method: string, result: unknown) =>
      (params: never): unknown => {
        received.push([method, params]);
        return result;
      };
    const capabilities = {
      structuredStreaming: true,
      reasoningStream: false,
      interactiveApprovals: true,
      resume: true,
      modelCatalog: true,
      images: false,
      usageReporting: true,
      cancellation: true,
      steering: false,
      sessionListing: false,
      nativeReview: false,
      accountUsage: false,
    };
    const configuration = {
      model: 'codex-default',
      effort: 'high',
      level: 'read-only' as const,
      routing: 'user' as const,
      workspaceRoots: ['/workspace'],
    };
    const runtime = await connectTestRuntime({
      handlers: {
        'external-agent.discover': record('external-agent.discover', {
          descriptors: [
            {
              targetId: 'codex',
              installed: true,
              authState: 'signed-in',
              capabilities,
              supportedConfigurations: [],
              models: [{ id: 'codex-default', isDefault: true }],
              account: { label: 'Ada', fingerprint: 'account-v1' },
            },
          ],
        }),
        'external-agent.open': record('external-agent.open', {
          nativeSessionId: 'native-session-1',
          resumed: false,
          effectiveConfiguration: configuration,
          capabilities,
        }),
        'external-agent.turn': record('external-agent.turn', { nativeTurnId: 'turn-1' }),
        'external-agent.respond': record('external-agent.respond', { ok: true }),
        'external-agent.cancel': record('external-agent.cancel', { ok: true }),
        'external-agent.close': record('external-agent.close', { ok: true }),
      },
    });
    const events: unknown[] = [];
    const unsubscribe = runtime.client.externalAgents.onEvent('session-1', (event) =>
      events.push(event)
    );

    try {
      const discovery = await runtime.client.externalAgents.discover({
        targetIds: ['codex'],
        timeoutMs: 1_000,
      });
      expect(discovery.descriptors[0]?.models?.[0]?.id).toBe('codex-default');
      expect(discovery.descriptors[0]?.account?.label).toBe('Ada');

      await runtime.client.externalAgents.open({
        sessionId: 'session-1',
        targetId: 'codex',
        workspacePath: '/workspace',
        configuration,
        resumeMode: 'fallback',
        timeoutMs: 1_000,
      });
      await runtime.client.externalAgents.turn({
        sessionId: 'session-1',
        clientMessageId: 'message-1',
        input: 'Inspect this workspace',
        configuration,
      });
      await runtime.client.externalAgents.respond({
        sessionId: 'session-1',
        nativeTurnId: 'turn-1',
        requestId: 'approval-1',
        optionId: 'allow-once',
      });
      await runtime.client.externalAgents.cancel({
        sessionId: 'session-1',
        nativeTurnId: 'turn-1',
      });
      await runtime.client.externalAgents.close({ sessionId: 'session-1' });

      expect(received.map(([method]) => method)).toEqual([
        'external-agent.discover',
        'external-agent.open',
        'external-agent.turn',
        'external-agent.respond',
        'external-agent.cancel',
        'external-agent.close',
      ]);
      expect(received[0]?.[1]).toEqual({ targetIds: ['codex'], timeoutMs: 1_000 });
      expect(received[2]?.[1]).toMatchObject({
        sessionId: 'session-1',
        clientMessageId: 'message-1',
        configuration,
      });

      runtime.emit({
        topic: 'external-agent.event',
        streamId: 'session-1',
        payload: {
          sessionId: 'session-other',
          nativeTurnId: 'turn-1',
          sequence: 1,
          emittedAtMs: Date.now(),
          event: { type: 'completed' },
        },
      });
      runtime.emit({
        topic: 'external-agent.event',
        streamId: 'session-1',
        payload: {
          sessionId: 'session-1',
          nativeTurnId: 'turn-1',
          sequence: 1,
          emittedAtMs: Date.now(),
          event: { type: 'completed' },
        },
      });
      await Bun.sleep(0);
      expect(events).toHaveLength(1);
    } finally {
      unsubscribe();
      await runtime.close();
    }
  });

  it('routes each half of the gh facade to its own protocol method', async () => {
    // The read/write split lives in the method name — the runtime's consent
    // gate never sees params — so a facade that sent both halves to one method
    // would silently let a read-only machine run a write.
    const received: [string, unknown][] = [];
    const record =
      (method: string) =>
      (params: never): unknown => {
        received.push([method, params]);
        return { stdout: '', stderr: '', exitCode: 0 };
      };
    const runtime = await connectTestRuntime({
      handlers: { 'gh.exec': record('gh.exec'), 'gh.mutate': record('gh.mutate') },
    });

    try {
      await runtime.client.gh.exec({ args: ['pr', 'view'], cwd: '/repo' });
      await runtime.client.gh.mutate({ args: ['pr', 'create', '--fill'], cwd: '/repo' });
    } finally {
      await runtime.close();
    }

    expect(received).toEqual([
      ['gh.exec', { args: ['pr', 'view'], cwd: '/repo' }],
      ['gh.mutate', { args: ['pr', 'create', '--fill'], cwd: '/repo' }],
    ]);
  });

  it('routes git.exec through the same multiplexer as its gh siblings', async () => {
    const received: unknown[] = [];
    const runtime = await connectTestRuntime({
      handlers: {
        'git.exec': (params) => {
          received.push(params);
          return { stdout: 'ok', stderr: '', exitCode: 0 };
        },
      },
    });

    try {
      await runtime.client.git.exec({ args: ['status'], cwd: '/repo' });
    } finally {
      await runtime.close();
    }

    expect(received).toEqual([{ args: ['status'], cwd: '/repo' }]);
  });

  it('inherits request timeout translation for external-agent methods', async () => {
    const runtime = await connectTestRuntime({
      handlers: {
        'external-agent.discover': (_params, { signal }) =>
          new Promise((_, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Discovery cancelled', 'AbortError')),
              { once: true }
            );
          }),
      },
    });

    try {
      await expect(
        runtime.client.externalAgents.discover(
          { targetIds: ['codex'], timeoutMs: 1_000 },
          { timeoutMs: 1 }
        )
      ).rejects.toBeInstanceOf(ToolExecutionTimedOutError);
    } finally {
      await runtime.close();
    }
  });

  it('translates an API abort into protocol cancellation without serializing the signal', async () => {
    let receivedParams: unknown;
    const runtime = await connectTestRuntime({
      handlers: {
        'snapshot.hash': (params, { signal }) => {
          receivedParams = params;
          // The cancel can land before the handler runs — consent is re-read
          // between the two — so a handler that only listened would wait for an
          // abort that already happened. Every real service checks first; see
          // `services/cancellation.ts`.
          if (signal.aborted) throw new DOMException('Cancelled by API test', 'AbortError');
          return new Promise((_, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Cancelled by API test', 'AbortError')),
              { once: true }
            );
          });
        },
      },
    });
    const controller = new AbortController();

    try {
      const request = runtime.client.snapshot.hash(
        { path: '/workspace/file.txt' },
        { signal: controller.signal }
      );
      controller.abort();

      await expect(request).rejects.toMatchObject({ name: 'AbortError' });
      expect(receivedParams).toEqual({ path: '/workspace/file.txt' });
      expect(receivedParams).not.toHaveProperty('signal');
    } finally {
      await runtime.close();
    }
  });

  it('translates a consent refusal into a typed error the turn pipeline can render', async () => {
    // The refusal comes from the real gate, not a handler pretending: this is
    // the path a `readonly` machine actually takes.
    const runtime = await connectTestRuntime({
      handlers: { 'shell.run': () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      consent: { slot: 'host', current: withoutShell, refresh: async () => withoutShell() },
    });

    try {
      const error = await runtime.client.shell
        .run({ command: 'true', kind: 'bash', timeoutMs: 1_000, maxOutputBytes: 1024 })
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(RuntimeConsentDeniedError);
      expect((error as RuntimeConsentDeniedError).details).toMatchObject({
        capability: 'shell',
        method: 'shell.run',
        slot: 'host',
        missing: ['shell'],
      });
    } finally {
      await runtime.close();
    }
  });

  it('rebuilds a service error from the kind that survived the wire', async () => {
    const runtime = await connectTestRuntime({
      handlers: {
        'fs.read-file': () => {
          throw new PathAccessError('"/etc/shadow" is outside every allowed root.');
        },
      },
    });

    try {
      await expect(
        runtime.client.fs.readFile({
          chatId: 'chat-1',
          inputPath: '/etc/shadow',
          resolvedPath: '/etc/shadow',
        })
      ).rejects.toBeInstanceOf(PathAccessError);
    } finally {
      await runtime.close();
    }
  });

  it('owns the manifest it was seeded with, without the contract announcement', async () => {
    // `hello.capabilities` carries the manifest *and* the contract version;
    // keeping the latter would make every `refreshManifest` comparison see a
    // change that never happened and publish an invalidation for nothing.
    const runtime = await connectTestRuntime({ handlers: {} });

    try {
      expect(runtime.client.manifest).toEqual(TEST_RUNTIME_MANIFEST);
      expect(runtime.client.manifest).not.toHaveProperty('contracts');
      expect(runtime.client.runtimeVersion).toBe('runtime-test');

      runtime.client.replaceManifest({ ...TEST_RUNTIME_MANIFEST, homeDir: '/somewhere/else' });
      expect(runtime.client.manifest.homeDir).toBe('/somewhere/else');
    } finally {
      await runtime.close();
    }
  });
});
