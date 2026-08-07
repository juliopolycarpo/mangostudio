import { afterEach, describe, expect, it, mock, setSystemTime } from 'bun:test';
import * as realChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { RuntimeRemoteError } from '@mangostudio/runtime';
import type {
  EnvironmentConnectionState,
  EnvironmentTransportKind,
} from '@mangostudio/shared/environments';
import {
  RUNTIME_CONSENT_PRESETS,
  type RuntimeHealthReport,
} from '@mangostudio/shared/runtime-home';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import { getVersion } from '../../../src/lib/config';
import { capabilityManifestFromHealth } from '../../../src/services/runtime-client/manifest-from-health';
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

const HEALTH_REPORT: RuntimeHealthReport = {
  schemaVersion: 1,
  slot: 'host',
  source: 'provisioned',
  runtimeVersion: '0.0.0-test',
  version: null,
  binaryPath: null,
  digest: null,
  profile: 'full',
  allow: RUNTIME_CONSENT_PRESETS.full,
  setup: { state: 'configured' },
  platform: 'linux',
  arch: 'x64',
  homeDir: '/home/test',
  shells: ['bash'],
  git: { available: true, version: '2.51.0' },
  lastError: null,
  audit: { enabled: false },
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

/** Lets a background refresh settle; it is deliberately not awaited by its caller. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A connected client that counts how often the hub asked it for health. */
function healthProbe(
  manifest: RuntimeCapabilityManifest,
  health: () => Promise<RuntimeHealthReport> = () => Promise.resolve(HEALTH_REPORT),
  runtimeVersion = '0.0.0-test'
): { client: RuntimeClient; calls: () => number } {
  let calls = 0;
  const client = {
    manifest,
    runtimeVersion,
    health: () => {
      calls += 1;
      return health();
    },
    replaceManifest: (next: RuntimeCapabilityManifest) => {
      client.manifest = next;
    },
  };
  return { client: client as unknown as RuntimeClient, calls: () => calls };
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

  it('does not disconnect a replacement client on behalf of a stale caller', async () => {
    const first = fakeConnection(() => undefined);
    const second = fakeConnection(() => undefined);
    let current = first;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: { stdio: () => Promise.resolve(current) },
    });

    const firstClient = await manager.connect('user-1', 'devbox');
    manager.disconnect('user-1', 'devbox');
    current = second;
    const secondClient = await manager.connect('user-1', 'devbox', { force: true });

    expect(manager.disconnectIfCurrent('user-1', 'devbox', firstClient)).toBe(false);
    expect(manager.getStatus('user-1', 'devbox').state).toBe('connected');
    expect(await manager.getClient('user-1', 'devbox')).toBe(secondClient);
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

  it('carries an ssh failure reason onto the status, where the card can act on it', async () => {
    // Every ssh failure arrives as RUNTIME_UNAVAILABLE, so the code alone
    // cannot tell "install a runtime there" from "trust the host key".
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition('ssh', { host: 'build-01' })),
      connectors: {
        ssh: () =>
          Promise.reject(
            new RuntimeRemoteError('RUNTIME_UNAVAILABLE', 'no runtime there', {
              sshFailureReason: 'runtime-missing',
            })
          ),
      },
    });

    await manager.connect('user-1', 'devbox').catch(() => undefined);

    expect(manager.getStatus('user-1', 'devbox')).toEqual({
      state: 'error',
      errorCode: 'RUNTIME_UNAVAILABLE',
      sshFailureReason: 'runtime-missing',
    });
  });

  it('drops a failure detail that is not one of the known reasons', async () => {
    // The value arrives through an untyped details bag, and the status shape it
    // lands in is a public contract.
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition('ssh', { host: 'build-01' })),
      connectors: {
        ssh: () =>
          Promise.reject(
            new RuntimeRemoteError('RUNTIME_UNAVAILABLE', 'nope', { sshFailureReason: 'nonsense' })
          ),
      },
    });

    await manager.connect('user-1', 'devbox').catch(() => undefined);

    expect(manager.getStatus('user-1', 'devbox')).toEqual({
      state: 'error',
      errorCode: 'RUNTIME_UNAVAILABLE',
    });
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

  it('adopts the restarted runtime without backoff and clears version drift', async () => {
    let attempts = 0;
    let dropConnection: (() => void) | undefined;
    const targetVersion = getVersion();
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: (_definition, onUnavailable) => {
          attempts += 1;
          dropConnection = onUnavailable;
          const probe = healthProbe(
            TEST_MANIFEST,
            () => Promise.resolve(HEALTH_REPORT),
            attempts === 1 ? '0.0.1-old' : targetVersion
          );
          return Promise.resolve({ client: probe.client, close: () => undefined });
        },
      },
    });

    await manager.getClient('user-1', 'devbox');
    expect(manager.getStatus('user-1', 'devbox')).toMatchObject({
      runtimeVersion: '0.0.1-old',
      runtimeVersionDrift: true,
    });
    manager.expectUpdateDisconnect('user-1', 'devbox');
    // Said before the connection drops, so the card never renders the gap as an
    // outage — this is the one disconnect that is the feature working.
    expect(manager.getStatus('user-1', 'devbox')).toMatchObject({
      state: 'connected',
      updating: true,
    });
    dropConnection?.();

    expect(manager.getStatus('user-1', 'devbox')).toEqual({
      state: 'disconnected',
      updating: true,
      manifest: TEST_MANIFEST,
      runtimeVersion: '0.0.1-old',
      runtimeVersionDrift: true,
    });
    await manager.getClient('user-1', 'devbox');
    expect(attempts).toBe(2);
    expect(manager.getStatus('user-1', 'devbox')).toMatchObject({
      state: 'connected',
      runtimeVersion: targetVersion,
      runtimeVersionDrift: false,
    });
    // The reconnect is the end of the handoff; nothing should still say updating.
    expect(manager.getStatus('user-1', 'devbox').updating).toBeUndefined();
  });

  it('stops claiming an update when the runtime refuses one', async () => {
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: () => {
          const probe = healthProbe(TEST_MANIFEST, () => Promise.resolve(HEALTH_REPORT));
          return Promise.resolve({ client: probe.client, close: () => undefined });
        },
      },
    });

    await manager.getClient('user-1', 'devbox');
    manager.expectUpdateDisconnect('user-1', 'devbox');
    manager.clearExpectedUpdateDisconnect('user-1', 'devbox');

    // A stale flag would swallow the next real crash's backoff, so a refusal
    // has to put the status back exactly where it was.
    expect(manager.getStatus('user-1', 'devbox').updating).toBeUndefined();
    expect(manager.getStatus('user-1', 'devbox')).toMatchObject({ state: 'connected' });
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

  it('re-reads a stale manifest in the background, once, without blocking the read', async () => {
    const probe = healthProbe(TEST_MANIFEST);
    let publishes = 0;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: () => Promise.resolve({ client: probe.client, close: () => undefined }),
      },
      publish: () => {
        publishes += 1;
      },
    });

    await manager.connect('user-1', 'devbox');
    publishes = 0;

    // The handshake manifest is a fresh read; nothing to ask about yet.
    manager.refreshManifestIfStale('user-1', 'devbox');
    await flushMicrotasks();
    expect(probe.calls()).toBe(0);

    advanceSeconds(20);
    // Two reads arriving together are one round-trip, not two.
    manager.refreshManifestIfStale('user-1', 'devbox');
    manager.refreshManifestIfStale('user-1', 'devbox');
    await flushMicrotasks();

    expect(probe.calls()).toBe(1);
    // The handshake said mcp was refused; the health report grants everything.
    expect(manager.getStatus('user-1', 'devbox').manifest?.features.mcp).toBe(true);
    expect(publishes).toBe(1);
  });

  it('publishes nothing when the machine answers exactly what was cached', async () => {
    // A card polling this endpoint is woken by the invalidation a refresh
    // publishes. Publishing an unchanged manifest would make every window
    // produce a refetch that produces another refresh.
    const probe = healthProbe(capabilityManifestFromHealth(HEALTH_REPORT));
    let publishes = 0;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: () => Promise.resolve({ client: probe.client, close: () => undefined }),
      },
      publish: () => {
        publishes += 1;
      },
    });

    await manager.connect('user-1', 'devbox');
    publishes = 0;

    advanceSeconds(20);
    manager.refreshManifestIfStale('user-1', 'devbox');
    await flushMicrotasks();

    expect(probe.calls()).toBe(1);
    expect(publishes).toBe(0);
  });

  it('does not re-ask a peer that just failed to answer', async () => {
    const probe = healthProbe(TEST_MANIFEST, () =>
      Promise.reject(new RuntimeRemoteError('TIMEOUT', 'no answer'))
    );
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: () => Promise.resolve({ client: probe.client, close: () => undefined }),
      },
    });

    await manager.connect('user-1', 'devbox');
    advanceSeconds(20);
    manager.refreshManifestIfStale('user-1', 'devbox');
    await flushMicrotasks();
    // Within the window of the attempt, not of the last success: a peer that
    // is failing slowly must not collect one round-trip per environment read.
    manager.refreshManifestIfStale('user-1', 'devbox');
    await flushMicrotasks();

    expect(probe.calls()).toBe(1);
    expect(manager.getStatus('user-1', 'devbox').manifest).toEqual(TEST_MANIFEST);
  });

  it('does not restore a released connection after a stale health refresh', async () => {
    let resolveHealth: ((report: RuntimeHealthReport) => void) | undefined;
    const healthPromise = new Promise<RuntimeHealthReport>((resolve) => {
      resolveHealth = resolve;
    });
    let replaceCalls = 0;
    const client = {
      manifest: TEST_MANIFEST,
      runtimeVersion: '0.0.0-test',
      health: () => healthPromise,
      replaceManifest: () => {
        replaceCalls += 1;
      },
    } as unknown as RuntimeClient;

    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: () => Promise.resolve({ client, close: () => undefined }),
      },
    });

    await manager.connect('user-1', 'devbox');
    const refresh = manager.refreshManifest('user-1', 'devbox');
    manager.disconnect('user-1', 'devbox');
    resolveHealth?.(HEALTH_REPORT);

    const status = await refresh;
    expect(status.state).toBe('disconnected');
    expect(replaceCalls).toBe(0);
  });

  it('clears cached health and peer identity without requiring a reconnect', async () => {
    const probe = healthProbe(TEST_MANIFEST);
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: () => Promise.resolve({ client: probe.client, close: () => undefined }),
      },
    });

    await manager.connect('user-1', 'devbox');
    await manager.refreshManifest('user-1', 'devbox');
    expect(manager.getCachedHealth('user-1', 'devbox')?.health.platform).toBe('linux');

    manager.disconnect('user-1', 'devbox');
    expect(manager.getCachedHealth('user-1', 'devbox')?.health.platform).toBe('linux');
    expect(manager.getStatus('user-1', 'devbox').manifest?.platform).toBe('linux');

    manager.clearHealth('user-1', 'devbox');
    expect(manager.getCachedHealth('user-1', 'devbox')).toBeNull();
    expect(manager.getStatus('user-1', 'devbox').manifest).toBeUndefined();
    expect(manager.getStatus('user-1', 'devbox').runtimeVersion).toBeUndefined();
  });
});

describe('connectWslRuntime', () => {
  const ORIGINAL_PLATFORM = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true });
    mock.restore();
  });

  /**
   * A `ChildProcess`-shaped `EventEmitter` that fails the way a spawn of a
   * missing executable does: an `error` event carrying `ENOENT`, followed by
   * the pipe closing with nothing said. `stdout.pause` and `stdin.write`/`end`
   * are the minimum `createStdioFramePort` and `spawnRuntimeChild` need to
   * tear the connection down without throwing on a missing method.
   */
  function enoentChild(): unknown {
    const stdout = Object.assign(new EventEmitter(), { pause: () => undefined });
    const stderr = new EventEmitter();
    const stdin = Object.assign(new EventEmitter(), { write: () => true, end: () => undefined });
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: () => undefined,
    });

    queueMicrotask(() => {
      child.emit('error', Object.assign(new Error('spawn wsl.exe ENOENT'), { code: 'ENOENT' }));
      child.emit('exit', null, null);
      child.exitCode = -1;
      stdout.emit('end');
    });

    return child;
  }

  it('reports a WSL launch failure at the resolved path, not "reinstall MangoStudio"', async () => {
    // connectWslRuntime is windows-gated before anything else runs.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    // The distribution already holds a matching runtime; only the runtime
    // launch itself — the second wsl.exe spawn — is under test here.
    await mock.module('../../../src/modules/environments/infrastructure/wsl-provisioner', () => ({
      wslProvisioner: { ensure: () => Promise.resolve() },
    }));
    await mock.module('node:child_process', () => ({
      ...realChildProcess,
      spawn: () => enoentChild(),
    }));

    const { connectWslRuntime } = await import(
      '../../../src/services/runtime-client/runtime-connection-manager'
    );

    const outcome = await connectWslRuntime(
      {
        id: 'win-distro',
        userId: 'user-1',
        name: 'WSL',
        transportKind: 'wsl',
        config: { distro: 'Ubuntu' },
        enabled: true,
      },
      () => undefined
    ).catch((caught: unknown) => caught);
    const error = outcome as RuntimeRemoteError;

    // Before this fix, a missing wsl.exe surfaced as "The runtime binary was
    // not found at wsl.exe. Reinstall MangoStudio…" — true of a missing
    // sibling runtime binary, not of WSL itself being absent, and it sent the
    // user to the wrong fix.
    expect(error).toBeInstanceOf(RuntimeRemoteError);
    expect(error.message).toContain('WSL could not be started');
    expect(error.message).not.toContain('Reinstall MangoStudio');
  });
});
