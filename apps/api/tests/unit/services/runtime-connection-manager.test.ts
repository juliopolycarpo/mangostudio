import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
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

function fakeConnection(
  onClose: () => void,
  manifest: RuntimeCapabilityManifest = TEST_MANIFEST
): ManagedRuntimeConnection {
  return {
    client: { manifest } as RuntimeClient,
    close: onClose,
  };
}

afterEach(() => {
  setRuntimeConnectionManagerForTests(undefined);
  setSystemTime();
});

/** Advances the clock past a backoff window without waiting for it. */
function advanceSeconds(seconds: number): void {
  setSystemTime(new Date(Date.now() + seconds * 1_000));
}

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

    await manager.connect('user-1', 'devbox', { force: true }).catch(() => undefined);
    expect(attempts).toBe(2);
  });

  it('holds a lazy retry inside the backoff window and releases it after', async () => {
    let attempts = 0;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: () => {
          attempts += 1;
          return Promise.reject(new Error('runtime exited'));
        },
      },
    });

    await manager.getClient('user-1', 'devbox').catch(() => undefined);
    expect(attempts).toBe(1);

    // A tool call arriving right after the failure must not respawn a process
    // that just died; it fails fast with the same code callers already handle.
    const held = await manager.getClient('user-1', 'devbox').catch((error) => error);
    expect(held.code).toBe('RUNTIME_UNAVAILABLE');
    expect(attempts).toBe(1);

    advanceSeconds(2);
    await manager.getClient('user-1', 'devbox').catch(() => undefined);
    expect(attempts).toBe(2);
  });

  it('lets a deliberate connect skip the backoff window', async () => {
    let attempts = 0;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: () => {
          attempts += 1;
          return Promise.reject(new Error('runtime exited'));
        },
      },
    });

    await manager.connect('user-1', 'devbox').catch(() => undefined);
    await manager.connect('user-1', 'devbox', { force: true }).catch(() => undefined);

    expect(attempts).toBe(2);
  });

  it('stops retrying after the attempt cap until an explicit reconnect', async () => {
    let attempts = 0;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: () => {
          attempts += 1;
          return Promise.reject(new Error('runtime exited'));
        },
      },
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await manager.getClient('user-1', 'devbox').catch(() => undefined);
      advanceSeconds(60);
    }
    expect(attempts).toBe(5);

    // Waiting no longer helps: only someone deciding to reconnect does.
    advanceSeconds(3_600);
    const latched = await manager.getClient('user-1', 'devbox').catch((error) => error);
    expect(latched.message).toContain('stopped retrying');
    expect(attempts).toBe(5);

    await manager.connect('user-1', 'devbox', { force: true }).catch(() => undefined);
    expect(attempts).toBe(6);
  });

  it('stops retrying immediately when the runtime is the wrong protocol version', async () => {
    let attempts = 0;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: () => {
          attempts += 1;
          return Promise.reject(new RuntimeRemoteError('PROTOCOL_MISMATCH', 'stale runtime'));
        },
      },
    });

    await manager.getClient('user-1', 'devbox').catch(() => undefined);
    // A stale binary cannot fix itself, so no amount of waiting earns a retry.
    advanceSeconds(3_600);
    await manager.getClient('user-1', 'devbox').catch(() => undefined);

    expect(attempts).toBe(1);
    expect(manager.getStatus('user-1', 'devbox').errorCode).toBe('PROTOCOL_MISMATCH');
  });

  it('reports a runtime that dies as disconnected and reconnects after the backoff', async () => {
    let attempts = 0;
    let closeCalls = 0;
    let dropConnection: (() => void) | undefined;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: (() => {
        const connector: RuntimeEnvironmentConnector = (_definition, onUnavailable) => {
          attempts += 1;
          dropConnection = onUnavailable;
          return Promise.resolve(fakeConnection(() => closeCalls++));
        };
        return { stdio: connector };
      })(),
    });

    await manager.getClient('user-1', 'devbox');
    dropConnection?.();

    // The target is usually still there — the process died, not the machine —
    // so the environment reads as disconnected rather than broken.
    expect(manager.getStatus('user-1', 'devbox')).toEqual({
      state: 'disconnected',
      errorCode: 'RUNTIME_UNAVAILABLE',
      manifest: TEST_MANIFEST,
    });
    expect(closeCalls).toBe(1);

    advanceSeconds(2);
    await manager.getClient('user-1', 'devbox');
    expect(attempts).toBe(2);
    expect(manager.getStatus('user-1', 'devbox').state).toBe('connected');
  });

  it('latches a runtime that dies immediately after every handshake', async () => {
    let attempts = 0;
    let dropConnection: (() => void) | undefined;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: (_definition, onUnavailable) => {
          attempts += 1;
          dropConnection = onUnavailable;
          return Promise.resolve(fakeConnection(() => undefined));
        },
      },
    });

    // A completed handshake only shows the runtime started. Starts that die on
    // arrival still have to reach the cap, or every caller respawns one anew.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await manager.getClient('user-1', 'devbox');
      dropConnection?.();
      advanceSeconds(60);
    }
    expect(attempts).toBe(5);

    const latched = await manager.getClient('user-1', 'devbox').catch((error) => error);
    expect(latched.message).toContain('stopped retrying');
    expect(attempts).toBe(5);
    expect(manager.getStatus('user-1', 'devbox').state).toBe('error');
  });

  it('starts a fresh count after a connection that lasted', async () => {
    let attempts = 0;
    let dropConnection: (() => void) | undefined;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: (_definition, onUnavailable) => {
          attempts += 1;
          dropConnection = onUnavailable;
          return attempts <= 4
            ? Promise.reject(new Error('runtime exited'))
            : Promise.resolve(fakeConnection(() => undefined));
        },
      },
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await manager.getClient('user-1', 'devbox').catch(() => undefined);
      advanceSeconds(60);
    }

    // The fifth attempt connects and stays up, so the earlier failures stop
    // counting against it — losing it later is a first failure, not a latch.
    await manager.getClient('user-1', 'devbox');
    advanceSeconds(60);
    dropConnection?.();

    expect(manager.getStatus('user-1', 'devbox').state).toBe('disconnected');
    advanceSeconds(60);
    await manager.getClient('user-1', 'devbox');
    expect(attempts).toBe(6);
  });

  it('clears a latched backoff when the environment is enabled again', async () => {
    let attempts = 0;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: () => {
          attempts += 1;
          return Promise.reject(new Error('runtime exited'));
        },
      },
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await manager.getClient('user-1', 'devbox').catch(() => undefined);
      advanceSeconds(60);
    }
    expect(manager.getStatus('user-1', 'devbox').state).toBe('error');

    // Re-enabling answers whatever the failures were about, so the next call
    // gets an attempt rather than the latch a disabled environment earned.
    manager.clearBackoff('user-1', 'devbox');

    expect(manager.getStatus('user-1', 'devbox').state).toBe('disconnected');
    await manager.getClient('user-1', 'devbox').catch(() => undefined);
    expect(attempts).toBe(6);
  });

  it('closes every live connection on shutdown', async () => {
    let closeCalls = 0;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: (userId, environmentId) =>
        Promise.resolve({ ...definition(), id: environmentId, userId }),
      connectors: { stdio: () => Promise.resolve(fakeConnection(() => closeCalls++)) },
    });

    await manager.getClient('user-1', 'devbox');
    await manager.getClient('user-2', 'buildbox');
    await manager.closeAll();

    expect(closeCalls).toBe(2);
    expect(manager.getStatus('user-1', 'devbox').state).toBe('disconnected');
    expect(manager.getStatus('user-2', 'buildbox').state).toBe('disconnected');
  });

  it('reports the runtime error code on the status while still throwing RUNTIME_UNAVAILABLE', async () => {
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: () =>
          Promise.reject(new RuntimeRemoteError('PROTOCOL_MISMATCH', 'hub is newer than runtime')),
      },
    });

    const error = await manager.connect('user-1', 'devbox').catch((caught) => caught);
    // Tool callers branch on RUNTIME_UNAVAILABLE, so the thrown code is fixed…
    expect(error.code).toBe('RUNTIME_UNAVAILABLE');
    // …while the card can still tell a version mismatch from an unreachable host.
    expect(manager.getStatus('user-1', 'devbox')).toEqual({
      state: 'error',
      errorCode: 'PROTOCOL_MISMATCH',
    });
  });

  it('connects a runtime whose path style differs from the hub', async () => {
    const foreignStyle = process.platform === 'win32' ? 'posix' : 'win32';
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: () =>
          Promise.resolve(
            fakeConnection(() => undefined, { ...TEST_MANIFEST, pathStyle: foreignStyle })
          ),
      },
    });

    const client = await manager.connect('user-1', 'devbox');

    // A WSL distro under a Windows hub is the case this exists for. Paths are
    // resolved through the connection's own manifest, so the hub addresses the
    // target on its terms instead of refusing to speak to it.
    expect(client.manifest.pathStyle).toBe(foreignStyle);
    expect(manager.getStatus('user-1', 'devbox')).toMatchObject({
      state: 'connected',
      manifest: { pathStyle: foreignStyle },
    });
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
