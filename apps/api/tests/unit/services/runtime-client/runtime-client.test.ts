import { describe, expect, it } from 'bun:test';
import {
  CONSENT_DENIED_KIND,
  connectInProcessRuntime,
  RuntimeConsentDeniedError,
  RuntimeHost,
  type RuntimeMethodHandler,
  RuntimeServiceError,
} from '@mangostudio/runtime';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';
import { ToolExecutionTimedOutError } from '../../../../src/services/tools/execution-timeout';

const manifest: RuntimeCapabilityManifest = {
  platform: 'test',
  arch: 'test',
  pathStyle: 'posix',
  homeDir: '/test',
  shells: [],
  git: { available: false },
  features: {
    tools: true,
    git: false,
    probing: false,
    mcp: false,
    library: false,
    checkpoints: true,
  },
};

describe('RuntimeClient', () => {
  it('routes the complete external-agent facade through the typed request multiplexer', async () => {
    const received: [string, unknown][] = [];
    const handler =
      (method: string, result: unknown): RuntimeMethodHandler =>
      (params) => {
        received.push([method, params]);
        return Promise.resolve(result);
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
    const handlers = new Map<string, RuntimeMethodHandler>([
      [
        'external-agent.discover',
        handler('external-agent.discover', {
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
      ],
      [
        'external-agent.open',
        handler('external-agent.open', {
          nativeSessionId: 'native-session-1',
          resumed: false,
          effectiveConfiguration: configuration,
          capabilities,
        }),
      ],
      ['external-agent.turn', handler('external-agent.turn', { nativeTurnId: 'turn-1' })],
      ['external-agent.respond', handler('external-agent.respond', { ok: true })],
      ['external-agent.cancel', handler('external-agent.cancel', { ok: true })],
      ['external-agent.close', handler('external-agent.close', { ok: true })],
    ]);
    const host = new RuntimeHost({ runtimeVersion: 'runtime-test', manifest, handlers });
    const connection = await connectInProcessRuntime(host, {
      hubVersion: 'hub-test',
      validateFrames: true,
    });
    const client = new RuntimeClient(connection.client);
    const events: unknown[] = [];
    const unsubscribe = client.externalAgents.onEvent('session-1', (event) => events.push(event));

    try {
      const discovery = await client.externalAgents.discover({
        targetIds: ['codex'],
        timeoutMs: 1_000,
      });
      expect(discovery.descriptors[0]?.models?.[0]?.id).toBe('codex-default');
      expect(discovery.descriptors[0]?.account?.label).toBe('Ada');

      await client.externalAgents.open({
        sessionId: 'session-1',
        targetId: 'codex',
        workspacePath: '/workspace',
        configuration,
        resumeMode: 'fallback',
        timeoutMs: 1_000,
      });
      await client.externalAgents.turn({
        sessionId: 'session-1',
        clientMessageId: 'message-1',
        input: 'Inspect this workspace',
        configuration,
      });
      await client.externalAgents.respond({
        sessionId: 'session-1',
        nativeTurnId: 'turn-1',
        requestId: 'approval-1',
        optionId: 'allow-once',
      });
      await client.externalAgents.cancel({ sessionId: 'session-1', nativeTurnId: 'turn-1' });
      await client.externalAgents.close({ sessionId: 'session-1' });

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
      host.emit({
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
      host.emit({
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
      await connection.close();
    }
  });

  it('inherits request timeout translation for external-agent methods', async () => {
    const handlers = new Map<string, RuntimeMethodHandler>([
      [
        'external-agent.discover',
        (_params, { signal }) =>
          new Promise((_, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Discovery cancelled', 'AbortError')),
              { once: true }
            );
          }),
      ],
    ]);
    const host = new RuntimeHost({ runtimeVersion: 'runtime-test', manifest, handlers });
    const connection = await connectInProcessRuntime(host, {
      hubVersion: 'hub-test',
      validateFrames: true,
    });
    const client = new RuntimeClient(connection.client);

    try {
      await expect(
        client.externalAgents.discover({ targetIds: ['codex'], timeoutMs: 1_000 }, { timeoutMs: 1 })
      ).rejects.toBeInstanceOf(ToolExecutionTimedOutError);
    } finally {
      await connection.close();
    }
  });

  it('translates an API abort into protocol cancellation without serializing the signal', async () => {
    let receivedParams: unknown;
    const handlers = new Map<string, RuntimeMethodHandler>([
      [
        'snapshot.hash',
        (params, { signal }) => {
          receivedParams = params;
          return new Promise((_, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Cancelled by API test', 'AbortError')),
              { once: true }
            );
          });
        },
      ],
    ]);
    const host = new RuntimeHost({
      runtimeVersion: 'runtime-test',
      manifest,
      handlers,
    });
    const connection = await connectInProcessRuntime(host, {
      hubVersion: 'hub-test',
      validateFrames: true,
    });
    const client = new RuntimeClient(connection.client);
    const controller = new AbortController();

    try {
      const request = client.snapshot.hash(
        { path: '/workspace/file.txt' },
        { signal: controller.signal }
      );
      controller.abort();

      await expect(request).rejects.toMatchObject({ name: 'AbortError' });
      expect(receivedParams).toEqual({ path: '/workspace/file.txt' });
      expect(receivedParams).not.toHaveProperty('signal');
    } finally {
      connection.close();
    }
  });

  it('translates RUNTIME_DENIED into a typed consent refusal', async () => {
    const handlers = new Map<string, RuntimeMethodHandler>([
      [
        'shell.run',
        () =>
          Promise.reject(
            new RuntimeServiceError(CONSENT_DENIED_KIND, 'shell is refused', {
              method: 'shell.run',
              missing: ['shell'],
              slot: 'host',
              capability: 'shell',
            })
          ),
      ],
    ]);
    const host = new RuntimeHost({
      runtimeVersion: 'runtime-test',
      manifest,
      handlers,
    });
    const connection = await connectInProcessRuntime(host, {
      hubVersion: 'hub-test',
      validateFrames: true,
    });
    const client = new RuntimeClient(connection.client);

    try {
      await expect(
        client.shell.run({
          command: 'true',
          kind: 'bash',
          timeoutMs: 1_000,
          maxOutputBytes: 1024,
        })
      ).rejects.toBeInstanceOf(RuntimeConsentDeniedError);
    } finally {
      connection.close();
    }
  });
});
