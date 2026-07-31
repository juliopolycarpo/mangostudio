import { afterEach, describe, expect, it } from 'bun:test';
import { RuntimeRemoteError } from '@mangostudio/runtime';
import type {
  EnvironmentConnectionState,
  EnvironmentTransportKind,
} from '@mangostudio/shared/environments';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  getRuntimeClient,
  type ManagedRuntimeConnection,
  RuntimeConnectionManager,
  type RuntimeEnvironmentConnector,
  setRuntimeConnectionManagerForTests,
} from '../../../src/services/runtime-client/runtime-connection-manager';

const TEST_MANIFEST: RuntimeCapabilityManifest = {
  platform: 'linux',
  arch: 'x64',
  pathStyle: 'posix',
  homeDir: '/home/test',
  shells: ['bash'],
  git: { available: true, version: '2.51.0' },
  features: {
    tools: true,
    git: true,
    probing: false,
    mcp: false,
    library: false,
    checkpoints: true,
  },
};

function definition(transportKind: EnvironmentTransportKind = 'stdio', config: unknown = {}) {
  return {
    id: 'devbox',
    userId: 'user-1',
    name: 'Devbox',
    transportKind,
    config,
    enabled: true,
  };
}

function fakeConnection(onClose: () => void): ManagedRuntimeConnection {
  return {
    client: { manifest: TEST_MANIFEST } as RuntimeClient,
    close: onClose,
  };
}

afterEach(() => {
  setRuntimeConnectionManagerForTests(undefined);
});

describe('RuntimeConnectionManager', () => {
  it('deduplicates lazy connects and preserves the manifest after disconnect', async () => {
    let finishConnect: ((connection: ManagedRuntimeConnection) => void) | undefined;
    let connectCalls = 0;
    let closeCalls = 0;
    const publishedStates: EnvironmentConnectionState[] = [];
    const connector: RuntimeEnvironmentConnector = () => {
      connectCalls += 1;
      return new Promise((resolve) => {
        finishConnect = resolve;
      });
    };
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: { stdio: connector },
      publish: () => publishedStates.push(manager.getStatus('user-1', 'devbox').state),
    });

    const first = manager.getClient('user-1', 'devbox');
    const second = manager.getClient('user-1', 'devbox');
    await Promise.resolve();
    await Promise.resolve();

    expect(manager.getStatus('user-1', 'devbox').state).toBe('connecting');
    expect(connectCalls).toBe(1);

    finishConnect?.(fakeConnection(() => closeCalls++));
    expect(await first).toBe(await second);
    expect(manager.getStatus('user-1', 'devbox')).toEqual({
      state: 'connected',
      manifest: TEST_MANIFEST,
    });

    manager.disconnect('user-1', 'devbox');
    expect(closeCalls).toBe(1);
    expect(manager.getStatus('user-1', 'devbox')).toEqual({
      state: 'disconnected',
      manifest: TEST_MANIFEST,
    });
    expect(publishedStates).toEqual(['connecting', 'connected', 'disconnected']);
  });

  it('maps connector failures to RUNTIME_UNAVAILABLE without caching a rejection', async () => {
    let attempts = 0;
    const connector: RuntimeEnvironmentConnector = () => {
      attempts += 1;
      return Promise.reject(new Error('runtime exited'));
    };
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: { stdio: connector },
    });

    const firstError = await manager.connect('user-1', 'devbox').catch((error) => error);
    expect(firstError).toBeInstanceOf(RuntimeRemoteError);
    expect(firstError.code).toBe('RUNTIME_UNAVAILABLE');
    expect(manager.getStatus('user-1', 'devbox')).toEqual({
      state: 'error',
      errorCode: 'RUNTIME_UNAVAILABLE',
    });

    await manager.connect('user-1', 'devbox').catch(() => undefined);
    expect(attempts).toBe(2);
  });

  it('revalidates stored config before invoking a connector', async () => {
    let connectorCalled = false;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition('stdio', { command: 'unsafe' })),
      connectors: {
        stdio: () => {
          connectorCalled = true;
          return Promise.resolve(fakeConnection(() => undefined));
        },
      },
    });

    const error = await manager.connect('user-1', 'devbox').catch((caught) => caught);
    expect(error.code).toBe('RUNTIME_UNAVAILABLE');
    expect(connectorCalled).toBe(false);
  });

  it('routes the singleton helper through the installed manager', async () => {
    const expected = fakeConnection(() => undefined).client;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: () => Promise.resolve({ client: expected, close: () => undefined }),
      },
    });
    setRuntimeConnectionManagerForTests(manager);

    expect(await getRuntimeClient('user-1', 'devbox')).toBe(expected);
  });
});
