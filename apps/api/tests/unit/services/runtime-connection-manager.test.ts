import { afterEach, describe, expect, it, mock, setSystemTime } from 'bun:test';
import * as realChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { type HandlerContext, RESERVED_ERROR_CODES, RemoteError } from '@mangostudio/protocol';
import type {
  EnvironmentConnectionState,
  EnvironmentTransportKind,
} from '@mangostudio/shared/environments';
import {
  RUNTIME_ALREADY_BOUND_CLOSE_CODE,
  type RuntimeCapabilityManifest,
  type RuntimeDiscoverResult,
} from '@mangostudio/shared/runtime-contract';
import {
  RUNTIME_CONSENT_PRESETS,
  type RuntimeHealthReport,
} from '@mangostudio/shared/runtime-home';
import { getDb } from '../../../src/db/database';
import { getVersion } from '../../../src/lib/config';
import { RuntimeBinaryNotFoundError } from '../../../src/lib/runtime-paths';
import type { EnvironmentStateTransition } from '../../../src/modules/environments/application/record-environment-activity';
import { createRuntimeAuthoritativeAgentDiscovery } from '../../../src/modules/external-agents/application/external-agent-discovery';
import { createExternalIdentityIsolationRegistry } from '../../../src/modules/external-agents/application/external-identity-isolation';
import { createHubWorkspaceAuthorizeHandler } from '../../../src/services/runtime-client/hub-workspace-authority';
import { capabilityManifestFromHealth } from '../../../src/services/runtime-client/manifest-from-health';
import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  createLocalRuntimeConnector,
  getRuntimeClient,
  type LocalRuntimeOpenOptions,
  localLaunchFailure,
  type ManagedRuntimeConnection,
  type RuntimeConnectContext,
  RuntimeConnectionManager,
  type RuntimeEnvironmentConnector,
  setRuntimeConnectionManagerForTests,
} from '../../../src/services/runtime-client/runtime-connection-manager';
import { RuntimeDiscoveryCache } from '../../../src/services/runtime-client/runtime-discovery-cache';
import { insertTestChat, insertTestUser } from '../../support/factories';
import { connectTestRuntime } from '../../support/runtime-fixture';

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

/** What the manager hands a connector, for the connectors tested directly. */
function connectContext(): RuntimeConnectContext {
  return { report: () => undefined, signal: new AbortController().signal };
}

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

function localDefinition(userId: string) {
  return {
    id: 'local',
    userId,
    name: 'Local',
    transportKind: 'in-process' as const,
    config: {},
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

/** A connection to a build that announces `fingerprint` and serves `runtime.discover`. */
class DiscoveringConnection implements ManagedRuntimeConnection {
  discoverCalls = 0;
  readonly client: RuntimeClient;
  readonly close = () => undefined;

  constructor(fingerprint: string) {
    const implementation = {
      schema: 1,
      fingerprint,
      features: {
        git: true,
        probing: false,
        mcp: false,
        library: false,
        checkpoints: true,
        fsRead: false,
        fsWrite: false,
        shell: false,
        update: false,
        externalAgents: false,
        terminal: false,
      },
    };
    const discover = (): Promise<RuntimeDiscoverResult> => {
      this.discoverCalls += 1;
      return Promise.resolve({
        ...implementation,
        methods: ['runtime.discover', 'runtime.health'],
      });
    };
    this.client = {
      manifest: { ...TEST_MANIFEST, implementation },
      discoverImplementation: discover,
    } as unknown as RuntimeClient;
  }
}

/**
 * A connector whose first call stalls indefinitely (released only by the
 * test, via the returned `release`) and whose every later call resolves
 * immediately with `fresh` — the shape a "does a stale attempt lose to a
 * newer one" test needs: attempt A must still be pending when attempt B is
 * made, and only the test controls when A's handshake finally answers.
 */
function stalledThenFreshConnector(fresh: ManagedRuntimeConnection): {
  connector: RuntimeEnvironmentConnector;
  signals: AbortSignal[];
  release: (connection: ManagedRuntimeConnection) => void;
} {
  const signals: AbortSignal[] = [];
  let release: (connection: ManagedRuntimeConnection) => void = () => undefined;
  let attempts = 0;
  const connector: RuntimeEnvironmentConnector = (_definition, _onUnavailable, context) => {
    attempts += 1;
    signals.push(context.signal);
    if (attempts === 1) {
      return new Promise((resolve) => {
        release = resolve;
      });
    }
    return Promise.resolve(fresh);
  };
  return {
    connector,
    signals,
    release: (connection) => release(connection),
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

  // A phase normally lives only as long as the attempt that reported it, because
  // every path out of connect() replaces the status wholesale. This one has to
  // survive onto `connected`: it describes the runtime that is now running.
  it('keeps an offline-cache launch on the connected status', async () => {
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: (_definition, _onUnavailable, { report }) => {
          report('offline-cache');
          return Promise.resolve(fakeConnection(() => undefined));
        },
      },
    });

    await manager.connect('user-1', 'devbox');

    expect(manager.getStatus('user-1', 'devbox')).toEqual({
      state: 'connected',
      manifest: TEST_MANIFEST,
      offlineRuntimeCache: true,
    });
  });

  it('does not carry one attempt’s offline launch onto the next', async () => {
    let offline = true;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: (_definition, _onUnavailable, { report }) => {
          if (offline) report('offline-cache');
          return Promise.resolve(fakeConnection(() => undefined));
        },
      },
    });

    await manager.connect('user-1', 'devbox');
    manager.disconnect('user-1', 'devbox');
    offline = false;
    await manager.connect('user-1', 'devbox', { force: true });

    expect(manager.getStatus('user-1', 'devbox').offlineRuntimeCache).toBeUndefined();
  });

  describe('runtime.discover cache', () => {
    /** A manager whose every connect hands out the next of `builds`. */
    function managerOver(builds: readonly DiscoveringConnection[]) {
      let next = 0;
      let drop: (() => void) | undefined;
      const manager = new RuntimeConnectionManager({
        resolveEnvironment: () => Promise.resolve(definition()),
        connectors: {
          stdio: (_definition, onUnavailable) => {
            drop = onUnavailable;
            return Promise.resolve(builds[next++] as DiscoveringConnection);
          },
        },
        discoveryCache: new RuntimeDiscoveryCache(),
      });
      const reconnectAfterDrop = async () => {
        drop?.();
        await manager.connect('user-1', 'devbox', { force: true });
      };
      return { manager, reconnectAfterDrop };
    }

    it('drops the cached surface when a reconnect announces another build', async () => {
      const builds = [
        new DiscoveringConnection('a'.repeat(64)),
        new DiscoveringConnection('a'.repeat(64)),
        new DiscoveringConnection('b'.repeat(64)),
      ];
      const { manager, reconnectAfterDrop } = managerOver(builds);

      await manager.connect('user-1', 'devbox');
      await manager.discoverImplementation('user-1', 'devbox');
      await reconnectAfterDrop();
      const sameBuild = await manager.discoverImplementation('user-1', 'devbox');
      await reconnectAfterDrop();
      const otherBuild = await manager.discoverImplementation('user-1', 'devbox');

      expect(builds.map((build) => build.discoverCalls)).toEqual([1, 0, 1]);
      expect(sameBuild?.fingerprint).toBe('a'.repeat(64));
      expect(otherBuild?.fingerprint).toBe('b'.repeat(64));
    });

    it('forgets the cached surface when the environment is disconnected deliberately', async () => {
      const builds = [
        new DiscoveringConnection('a'.repeat(64)),
        new DiscoveringConnection('a'.repeat(64)),
      ];
      const { manager } = managerOver(builds);

      await manager.connect('user-1', 'devbox');
      await manager.discoverImplementation('user-1', 'devbox');
      manager.disconnect('user-1', 'devbox');
      await manager.connect('user-1', 'devbox', { force: true });
      await manager.discoverImplementation('user-1', 'devbox');

      expect(builds.map((build) => build.discoverCalls)).toEqual([1, 1]);
    });
  });

  // #792: the pull is bounded at half an hour, which no proxy or browser holds
  // an idle request through. The attempt keeps running; the request does not.
  describe('connectInteractive', () => {
    /** A connector stuck in a pull, plus the handles a test needs to steer it. */
    function pullingConnector() {
      const state = {
        calls: 0,
        signals: [] as AbortSignal[],
        finish: (): void => undefined,
      };
      const connector: RuntimeEnvironmentConnector = (_definition, _onUnavailable, context) => {
        state.calls += 1;
        state.signals.push(context.signal);
        context.report('pulling');
        return new Promise<ManagedRuntimeConnection>((resolve) => {
          state.finish = () => resolve(fakeConnection(() => undefined));
        });
      };
      return { connector, state };
    }

    function pullingManager(connector: RuntimeEnvironmentConnector) {
      return new RuntimeConnectionManager({
        resolveEnvironment: () => Promise.resolve(definition('container', { image: 'node:22' })),
        connectors: { container: connector },
      });
    }

    it('answers once the pull starts, leaving the attempt running', async () => {
      const { connector, state } = pullingConnector();
      const manager = pullingManager(connector);

      expect(await manager.connectInteractive('user-1', 'devbox')).toBe('pulling');
      expect(manager.getStatus('user-1', 'devbox')).toEqual({
        state: 'connecting',
        pullingImage: true,
      });

      state.finish();
      await flushMicrotasks();
      expect(manager.getStatus('user-1', 'devbox').state).toBe('connected');
    });

    it('joins the pull already in flight rather than starting a second one', async () => {
      const { connector, state } = pullingConnector();
      const manager = pullingManager(connector);

      expect(await manager.connectInteractive('user-1', 'devbox')).toBe('pulling');
      expect(await manager.connectInteractive('user-1', 'devbox')).toBe('pulling');

      expect(state.calls).toBe(1);
    });

    it('cancels the pull when the environment is disconnected', async () => {
      const { connector, state } = pullingConnector();
      const manager = pullingManager(connector);

      await manager.connectInteractive('user-1', 'devbox');
      expect(state.signals[0]?.aborted).toBe(false);

      manager.disconnect('user-1', 'devbox');

      expect(state.signals[0]?.aborted).toBe(true);
      expect(manager.getStatus('user-1', 'devbox').state).toBe('disconnected');
    });

    it('still waits out an attempt that never reaches a pull', async () => {
      const manager = new RuntimeConnectionManager({
        resolveEnvironment: () => Promise.resolve(definition()),
        connectors: { stdio: () => Promise.resolve(fakeConnection(() => undefined)) },
      });

      expect(await manager.connectInteractive('user-1', 'devbox')).toBe('connected');
      expect(manager.getStatus('user-1', 'devbox').state).toBe('connected');
    });

    it('reports a failure that happens before any pull', async () => {
      const manager = new RuntimeConnectionManager({
        resolveEnvironment: () => Promise.resolve(definition()),
        connectors: { stdio: () => Promise.reject(new Error('no engine')) },
      });

      await expect(manager.connectInteractive('user-1', 'devbox')).rejects.toThrow('no engine');
      expect(manager.getStatus('user-1', 'devbox').state).toBe('error');
    });
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

  it('discards a superseded attempt that resolves after its signal was aborted', async () => {
    // Disconnecting attempt A aborts its context signal, but the connector
    // below never actually honors that signal — it stays pending and later
    // resolves for real, exactly as a connector that ignores cancellation
    // would. Attempt A's handshake is held open by the test — a genuinely
    // deferred connector, not a timing race — so it can be released only
    // after attempt B has already published, proving the late arrival is
    // discarded on its own merits (superseded), not merely assumed to lose
    // a race it never actually ran.
    const closedStale: string[] = [];
    const staleConnection = fakeConnection(() => {
      closedStale.push('closed');
    });
    const fresh = fakeConnection(() => undefined);
    const { connector, signals, release } = stalledThenFreshConnector(fresh);
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: { stdio: connector },
    });

    // Attempt A starts, then the caller gives up on it before it handshakes —
    // a disconnect, or a second `connect()` call from real code.
    const staleAttempt = manager.connect('user-1', 'devbox');
    await Promise.resolve();
    await Promise.resolve();
    manager.disconnect('user-1', 'devbox');
    expect(signals[0]?.aborted).toBe(true);

    // Attempt B starts fresh and completes normally.
    const freshClient = await manager.connect('user-1', 'devbox', { force: true });
    expect(manager.getStatus('user-1', 'devbox').state).toBe('connected');

    // A's handshake finally answers, after B has already published.
    release(staleConnection);
    await expect(staleAttempt).rejects.toThrow('Runtime connection was closed.');

    expect(closedStale).toEqual(['closed']);
    expect(manager.getStatus('user-1', 'devbox').state).toBe('connected');
    expect(await manager.getClient('user-1', 'devbox')).toBe(freshClient);
  });

  it('maps connector failures to UNAVAILABLE without caching a rejection', async () => {
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
    expect(firstError).toBeInstanceOf(RemoteError);
    expect(firstError.code).toBe(RESERVED_ERROR_CODES.UNAVAILABLE);
    expect(manager.getStatus('user-1', 'devbox')).toEqual({
      state: 'error',
      errorCode: RESERVED_ERROR_CODES.UNAVAILABLE,
    });

    await manager.connect('user-1', 'devbox', { force: true }).catch(() => undefined);
    expect(attempts).toBe(2);
  });

  it('carries an ssh failure reason onto the status, where the card can act on it', async () => {
    // Every ssh failure arrives as UNAVAILABLE, so the code alone cannot tell
    // "install a runtime there" from "trust the host key".
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition('ssh', { host: 'build-01' })),
      connectors: {
        ssh: () =>
          Promise.reject(
            new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, 'no runtime there', {
              sshFailureReason: 'runtime-missing',
            })
          ),
      },
    });

    await manager.connect('user-1', 'devbox').catch(() => undefined);

    expect(manager.getStatus('user-1', 'devbox')).toEqual({
      state: 'error',
      errorCode: 'UNAVAILABLE',
      sshFailureReason: 'runtime-missing',
    });
  });

  it('reports a missing Local binary as its own reason on the card', async () => {
    const missing = localLaunchFailure(
      new RuntimeBinaryNotFoundError(['/repo/target/debug/mangostudio-runtime']),
      true
    );
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(localDefinition('user-1')),
      connectors: { 'in-process': () => Promise.reject(missing) },
    });

    await manager.connect('user-1', 'local').catch(() => undefined);

    expect(missing.message).toContain('cargo build -p mangostudio-runtime');
    expect(manager.getStatus('user-1', 'local')).toEqual({
      state: 'error',
      errorCode: 'UNAVAILABLE',
      localFailureReason: 'binary-missing',
    });
  });

  it('keeps a Local failure that is not a missing binary as it was', () => {
    const mismatch = new RemoteError(RESERVED_ERROR_CODES.PROTOCOL_MISMATCH, 'old release', {
      runtimeVersion: '0.0.1',
    });
    const handshake = new Error('the runtime did not complete its handshake');

    expect(localLaunchFailure(mismatch, false)).toBe(mismatch);
    expect(localLaunchFailure(handshake, false)).toMatchObject({
      code: RESERVED_ERROR_CODES.UNAVAILABLE,
      message: 'the runtime did not complete its handshake',
      details: {},
    });
    // A missing binary keeps the code and details the launch produced.
    expect(localLaunchFailure(mismatch, true)).toMatchObject({
      code: RESERVED_ERROR_CODES.PROTOCOL_MISMATCH,
      details: { runtimeVersion: '0.0.1', localFailureReason: 'binary-missing' },
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
            new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, 'nope', {
              sshFailureReason: 'nonsense',
            })
          ),
      },
    });

    await manager.connect('user-1', 'devbox').catch(() => undefined);

    expect(manager.getStatus('user-1', 'devbox')).toEqual({
      state: 'error',
      errorCode: 'UNAVAILABLE',
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
    expect(held.code).toBe(RESERVED_ERROR_CODES.UNAVAILABLE);
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
          return Promise.reject(new RemoteError('PROTOCOL_MISMATCH', 'stale runtime'));
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

  describe('a runtime already bound to another environment record', () => {
    /** Refuses every dial the way `openHubSession` does when `serve` closes 4423. */
    function boundElsewhereConnector(counter: { attempts: number }): RuntimeEnvironmentConnector {
      return () => {
        counter.attempts += 1;
        return Promise.reject(
          new RemoteError(
            RESERVED_ERROR_CODES.UNAVAILABLE,
            'The session closed before the handshake completed (4423).',
            { closeCode: RUNTIME_ALREADY_BOUND_CLOSE_CODE }
          )
        );
      };
    }

    it('reports bound elsewhere and holds lazy retries for the slow window, not the fast backoff', async () => {
      const counter = { attempts: 0 };
      const manager = new RuntimeConnectionManager({
        resolveEnvironment: () =>
          Promise.resolve(definition('http', { baseUrl: 'http://127.0.0.1:7777' })),
        connectors: { http: boundElsewhereConnector(counter) },
      });

      const refusal = await manager.getClient('user-1', 'devbox').catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(RemoteError);
      expect((refusal as RemoteError).code).toBe(RESERVED_ERROR_CODES.UNAVAILABLE);
      expect((refusal as RemoteError).message).toContain('already bound to another environment');
      expect(manager.getStatus('user-1', 'devbox')).toEqual({
        state: 'error',
        errorCode: RESERVED_ERROR_CODES.UNAVAILABLE,
        boundElsewhere: true,
      });

      // Far past the fast backoff's first step (1s), and still held.
      advanceSeconds(59);
      const held = await manager.getClient('user-1', 'devbox').catch((error: unknown) => error);
      expect((held as Error).message).toContain('next connection attempt is allowed in');
      expect(counter.attempts).toBe(1);
    });

    it('never latches: after the slow window it tries again, however often it was refused', async () => {
      const counter = { attempts: 0 };
      const manager = new RuntimeConnectionManager({
        resolveEnvironment: () =>
          Promise.resolve(definition('http', { baseUrl: 'http://127.0.0.1:7777' })),
        connectors: { http: boundElsewhereConnector(counter) },
      });

      for (let attempt = 0; attempt < 8; attempt += 1) {
        await manager.getClient('user-1', 'devbox').catch(() => undefined);
        advanceSeconds(61);
      }
      expect(counter.attempts).toBe(8);
      expect(manager.getStatus('user-1', 'devbox').boundElsewhere).toBe(true);
      expect(manager.getStatus('user-1', 'devbox').state).toBe('error');
    });

    it('drops the bound-elsewhere status once the record connects', async () => {
      let refuse = true;
      const manager = new RuntimeConnectionManager({
        resolveEnvironment: () =>
          Promise.resolve(definition('http', { baseUrl: 'http://127.0.0.1:7777' })),
        connectors: {
          http: () =>
            refuse
              ? Promise.reject(
                  new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, 'closed', {
                    closeCode: RUNTIME_ALREADY_BOUND_CLOSE_CODE,
                  })
                )
              : Promise.resolve(fakeConnection(() => undefined)),
        },
      });

      await manager.getClient('user-1', 'devbox').catch(() => undefined);
      refuse = false;
      await manager.connect('user-1', 'devbox', { force: true });
      expect(manager.getStatus('user-1', 'devbox').state).toBe('connected');
      expect(manager.getStatus('user-1', 'devbox').boundElsewhere).toBeUndefined();
    });
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
      errorCode: RESERVED_ERROR_CODES.UNAVAILABLE,
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

  it('contains a superseded connection whose teardown rejects', async () => {
    // `close` now reaches the runtime's own teardown, and an external-agent
    // session owns vendor process trees that can refuse to reap. Nothing awaits
    // a superseded close, so an unhandled rejection here would end the hub.
    const rejecting: ManagedRuntimeConnection = {
      client: { manifest: TEST_MANIFEST } as RuntimeClient,
      close: () => Promise.reject(new Error('vendor process tree would not reap')),
    };
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {},
    });
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      await manager.adopt('user-1', 'devbox', () => Promise.resolve(rejecting));
      await manager.adopt('user-1', 'devbox', () =>
        Promise.resolve(fakeConnection(() => undefined))
      );
      await flushMicrotasks();
    } finally {
      console.warn = realWarn;
    }

    expect(warnings.join('\n')).toContain('vendor process tree would not reap');
    expect(manager.getStatus('user-1', 'devbox').state).toBe('connected');
  });

  it('reports the runtime error code on the status while still throwing UNAVAILABLE', async () => {
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: () =>
          Promise.reject(new RemoteError('PROTOCOL_MISMATCH', 'hub is newer than runtime')),
      },
    });

    const error = await manager.connect('user-1', 'devbox').catch((caught) => caught);
    // Tool callers branch on the unavailable code, so the thrown code is fixed…
    expect(error.code).toBe(RESERVED_ERROR_CODES.UNAVAILABLE);
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
    expect(error.code).toBe(RESERVED_ERROR_CODES.UNAVAILABLE);
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
  const ATTESTED: RuntimeCapabilityManifest['identityIsolation'] = {
    method: 'single-user-host',
    credentialHomeFingerprint: 'sha256:test',
  };

  /** What the Local runtime answers a hub that did or did not withdraw its claim. */
  const attestationFor = (
    isolation: 'single-user' | 'withdrawn'
  ): Pick<RuntimeCapabilityManifest, 'identityIsolation'> =>
    isolation === 'single-user' ? { identityIsolation: ATTESTED } : {};

  it.each(['withdrawn', 'single-user', undefined] as const)(
    'preserves the hub isolation claim %s after a peer repeats its attestation',
    async (claim) => {
      const manifest: RuntimeCapabilityManifest = {
        ...TEST_MANIFEST,
        externalAgents: ['codex'],
        features: { ...TEST_MANIFEST.features, externalAgents: true },
        identityIsolation: ATTESTED,
      };
      let discoveryCalls = 0;
      const runtime = await connectTestRuntime({
        manifest,
        ...(claim ? { externalAgentIsolation: claim } : {}),
        handlers: {
          'runtime.health': () => ({
            ...HEALTH_REPORT,
            allow: { ...HEALTH_REPORT.allow, externalAgents: true },
            externalAgents: {
              targets: ['codex'],
              identityIsolation: ATTESTED,
              liveSessionCount: 0,
              liveSessions: [],
            },
          }),
          'external-agent.discover': () => {
            discoveryCalls += 1;
            return { descriptors: [] };
          },
        },
      });
      const manager = new RuntimeConnectionManager({
        resolveEnvironment: () => Promise.resolve(definition()),
        connectors: { stdio: () => Promise.resolve(runtime) },
      });
      try {
        const client = await manager.getClient('user-1', 'devbox');
        const expected = claim === 'withdrawn' ? undefined : ATTESTED;
        expect(client.manifest.identityIsolation).toEqual(expected);
        const refreshed = await manager.refreshManifest('user-1', 'devbox');
        const authority = createRuntimeAuthoritativeAgentDiscovery(
          () => Promise.resolve(client),
          1_000,
          createExternalIdentityIsolationRegistry()
        );
        const [status] = await authority.describe(
          { userId: 'user-1', environmentId: 'devbox' },
          ['codex'],
          { signal: new AbortController().signal }
        );
        if (claim === 'withdrawn') {
          expect(status?.unavailableReason).toBe('isolation-unproven');
          expect(discoveryCalls).toBe(0);
        } else {
          expect(discoveryCalls).toBe(1);
        }
        expect(client.manifest.identityIsolation).toEqual(expected);
        expect(refreshed.manifest?.identityIsolation).toEqual(expected);
        expect(manifest.identityIsolation).toEqual(ATTESTED);
      } finally {
        manager.disconnect('user-1', 'devbox');
        await runtime.close();
      }
    }
  );

  /**
   * A Local `open` that answers at once, the way the spawned runtime does: an
   * attested manifest when the hub claimed `single-user`, none when it
   * withdrew. Records every call's options so a test can read what the
   * connector asked for.
   */
  function recordingLocalOpen() {
    const calls: LocalRuntimeOpenOptions[] = [];
    const open = (options: LocalRuntimeOpenOptions): Promise<ManagedRuntimeConnection> => {
      calls.push(options);
      return Promise.resolve(
        fakeConnection(() => undefined, {
          ...TEST_MANIFEST,
          ...attestationFor(options.externalAgentIsolation),
        })
      );
    };
    return { open, calls };
  }

  it('revokes Local attestation before serving a second MangoStudio user', async () => {
    const opens = recordingLocalOpen();
    const connector = createLocalRuntimeConnector({ open: opens.open });
    let firstUnavailable = 0;
    let sameOwnerUnavailable = 0;
    await expect(
      connector(
        { ...localDefinition('user-0'), id: 'not-local' },
        () => undefined,
        connectContext()
      )
    ).rejects.toMatchObject({
      code: RESERVED_ERROR_CODES.UNAVAILABLE,
      message: expect.stringContaining('reserved for the Local environment'),
    });
    const systemProbe = await connector(
      localDefinition('local'),
      () => undefined,
      connectContext()
    );
    const first = await connector(
      localDefinition('user-1'),
      () => {
        firstUnavailable += 1;
      },
      connectContext()
    );
    const sameOwner = await connector(
      localDefinition('user-1'),
      () => {
        sameOwnerUnavailable += 1;
      },
      connectContext()
    );
    const second = await connector(localDefinition('user-2'), () => undefined, connectContext());
    const firstAfterTransition = await connector(
      localDefinition('user-1'),
      () => undefined,
      connectContext()
    );

    try {
      expect(opens.calls.map((call) => call.externalAgentIsolation)).toEqual([
        'withdrawn',
        'single-user',
        'single-user',
        'withdrawn',
        'withdrawn',
      ]);
      expect({
        systemProbe: systemProbe.identityAttested,
        first: first.identityAttested,
        sameOwner: sameOwner.identityAttested,
        second: second.identityAttested,
        firstAfterTransition: firstAfterTransition.identityAttested,
      }).toEqual({
        systemProbe: undefined,
        first: true,
        sameOwner: true,
        second: false,
        firstAfterTransition: false,
      });
      expect({ firstUnavailable, sameOwnerUnavailable }).toEqual({
        firstUnavailable: 1,
        sameOwnerUnavailable: 1,
      });
    } finally {
      await firstAfterTransition.close();
      await second.close();
      await sameOwner.close();
      await first.close();
      await systemProbe.close();
    }
  });

  it('binds every Local open to its user on the Local environment', async () => {
    const opens = recordingLocalOpen();
    const connector = createLocalRuntimeConnector({ open: opens.open });
    const attempt = new AbortController();
    const probe = await connector(localDefinition('local'), () => undefined, connectContext());
    const owned = await connector(localDefinition('user-1'), () => undefined, {
      report: () => undefined,
      signal: attempt.signal,
    });

    try {
      expect(opens.calls.map((call) => call.workspaceBinding)).toEqual([
        { userId: 'local', environmentId: 'local' },
        { userId: 'user-1', environmentId: 'local' },
      ]);
      // The attempt's own signal, so releasing the attempt reaches the spawn.
      expect(opens.calls[1]?.signal).toBe(attempt.signal);
    } finally {
      await owned.close();
      await probe.close();
    }
  });

  it('authorizes only Local chat workdirs persisted for the same owner', async () => {
    const [owner, other] = await Promise.all([insertTestUser(), insertTestUser()]);
    const [ownedChat, otherChat, remoteChat] = await Promise.all([
      insertTestChat(owner.id),
      insertTestChat(other.id),
      insertTestChat(owner.id),
    ]);
    const ownedWorkdir = '/workspace/owned';
    const otherWorkdir = '/workspace/other';
    const remoteWorkdir = '/workspace/remote';
    await Promise.all([
      getDb()
        .updateTable('chats')
        .set({ workdir: ownedWorkdir, environmentId: 'local' })
        .where('id', '=', ownedChat.id)
        .execute(),
      getDb()
        .updateTable('chats')
        .set({ workdir: otherWorkdir, environmentId: 'local' })
        .where('id', '=', otherChat.id)
        .execute(),
      getDb()
        .updateTable('chats')
        .set({ workdir: remoteWorkdir, environmentId: 'devbox' })
        .where('id', '=', remoteChat.id)
        .execute(),
    ]);

    const opens = recordingLocalOpen();
    const connector = createLocalRuntimeConnector({ open: opens.open });
    const connection = await connector(
      localDefinition(owner.id),
      () => undefined,
      connectContext()
    );

    try {
      const binding = opens.calls[0]?.workspaceBinding;
      if (!binding) {
        throw new Error(`expected one Local open | received: ${opens.calls.length} open(s)`);
      }
      // The handler the spawned runtime's `hub.workspace.authorize` reaches.
      const authorize = createHubWorkspaceAuthorizeHandler(binding);
      const ask = async (canonicalPath: string, signal = new AbortController().signal) =>
        (
          await authorize({ canonicalPath, purpose: 'external-agent' }, {
            signal,
          } as HandlerContext)
        ).authorized;
      expect(await ask(ownedWorkdir)).toBe(true);
      expect(await ask(otherWorkdir)).toBe(false);
      expect(await ask(remoteWorkdir)).toBe(false);
      expect(await ask('/workspace/missing')).toBe(false);
      const cancelled = new AbortController();
      cancelled.abort(new Error('authorization cancelled'));
      await expect(ask(ownedWorkdir, cancelled.signal)).rejects.toThrow('authorization cancelled');
    } finally {
      await connection.close();
    }
  });

  it('binds the Local owner only after a successful connection', async () => {
    const claims: Array<'single-user' | 'withdrawn'> = [];
    let attempts = 0;
    const connector = createLocalRuntimeConnector({
      open: (options) => {
        claims.push(options.externalAgentIsolation);
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new Error('first handshake failed'));
        }
        return Promise.resolve(
          fakeConnection(() => undefined, {
            ...TEST_MANIFEST,
            ...attestationFor(options.externalAgentIsolation),
          })
        );
      },
    });

    await expect(
      connector(localDefinition('user-1'), () => undefined, connectContext())
    ).rejects.toThrow('first handshake failed');
    const second = await connector(localDefinition('user-2'), () => undefined, connectContext());

    try {
      expect(claims).toEqual(['single-user', 'single-user']);
      expect(second.client.manifest.identityIsolation).toMatchObject({
        method: 'single-user-host',
      });
    } finally {
      await second.close();
    }
  });

  // The wedge behind #922. `getClient` hands the in-flight promise to every
  // later caller, so an in-process attempt that never settles is not one slow
  // call — it is every subsequent call, forever. What breaks that is the
  // eviction the deadline triggers, so the assertions that matter are the ones
  // after the rejection.
  it('evicts an in-process connect that never settles instead of queueing on it', async () => {
    let connectCalls = 0;
    let lateCloses = 0;
    let finishWedged: ((connection: ManagedRuntimeConnection) => void) | undefined;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(localDefinition('user-1')),
      connectors: {
        'in-process': () => {
          connectCalls += 1;
          if (connectCalls > 1) return Promise.resolve(fakeConnection(() => undefined));
          return new Promise<ManagedRuntimeConnection>((resolve) => {
            finishWedged = resolve;
          });
        },
      },
      connectDeadlinesMs: { 'in-process': 25 },
    });

    // Both callers are settled together rather than awaited one after the
    // other: they share one rejection, and awaiting them in sequence leaves the
    // second one momentarily unhandled, which Bun reports as a test failure.
    const [wedged, joined] = await Promise.all([
      manager.getClient('user-1', 'local').catch((error: unknown) => error),
      manager.getClient('user-1', 'local').catch((error: unknown) => error),
    ]);
    const timedOut = {
      code: RESERVED_ERROR_CODES.UNAVAILABLE,
      message: 'Connecting to environment "local" timed out after 25ms.',
    };
    expect(wedged).toMatchObject(timedOut);
    expect(joined).toMatchObject(timedOut);
    expect(manager.getStatus('user-1', 'local')).toMatchObject({
      state: 'error',
      errorCode: RESERVED_ERROR_CODES.UNAVAILABLE,
    });

    // The entry is evicted, not held: the next caller is answered by the
    // ordinary backoff rather than joining the corpse of the first attempt.
    await expect(manager.getClient('user-1', 'local')).rejects.toMatchObject({
      message: expect.stringContaining('the next connection attempt is allowed in'),
    });
    expect(connectCalls).toBe(1);

    advanceSeconds(2);
    expect((await manager.getClient('user-1', 'local')).manifest).toEqual(TEST_MANIFEST);
    expect(connectCalls).toBe(2);

    // A connection that arrives after its attempt was abandoned owns a live
    // runtime host that nothing else will ever close.
    finishWedged?.(fakeConnection(() => lateCloses++));
    await flushMicrotasks();
    expect(lateCloses).toBe(1);
  });

  it('lets the next Local connect start while the previous attempt is stuck', async () => {
    let openCalls = 0;
    let releaseStuck: ((connection: ManagedRuntimeConnection) => void) | undefined;
    const connector = createLocalRuntimeConnector({
      chainDeadlineMs: 25,
      open: () => {
        openCalls += 1;
        if (openCalls > 1) return Promise.resolve(fakeConnection(() => undefined));
        return new Promise<ManagedRuntimeConnection>((resolve) => {
          releaseStuck = resolve;
        });
      },
    });

    const stuck = connector(localDefinition('user-1'), () => undefined, connectContext());
    // Before the chain was bounded this never settled: the serial chain only
    // advanced when the previous attempt did.
    const next = await connector(localDefinition('user-1'), () => undefined, connectContext());

    try {
      expect(openCalls).toBe(2);
      expect(next.client.manifest).toEqual(TEST_MANIFEST);
    } finally {
      releaseStuck?.(fakeConnection(() => undefined));
      await (await stuck).close();
      await next.close();
    }
  });

  /**
   * A Local `open` whose calls the test settles by hand and in any order — the
   * shape a pending-claim race needs, because which attempt finishes first is
   * the whole question. Each call records the isolation claim it was given.
   */
  function scriptedLocalOpen() {
    const calls: Array<{
      readonly isolation: 'single-user' | 'withdrawn';
      readonly succeed: (close?: () => void | Promise<void>) => void;
      readonly succeedWith: (connection: ManagedRuntimeConnection) => void;
      readonly fail: (error: Error) => void;
    }> = [];
    const open = (options: {
      readonly externalAgentIsolation: 'single-user' | 'withdrawn';
    }): Promise<ManagedRuntimeConnection> => {
      const opened = Promise.withResolvers<ManagedRuntimeConnection>();
      const isolation = options.externalAgentIsolation;
      calls.push({
        isolation,
        succeed: (close = () => undefined) => {
          opened.resolve(fakeConnection(close, { ...TEST_MANIFEST, ...attestationFor(isolation) }));
        },
        succeedWith: (connection) => {
          opened.resolve(connection);
        },
        fail: (error) => {
          opened.reject(error);
        },
      });
      return opened.promise;
    };
    const call = (index: number) => {
      const found = calls[index];
      if (!found) {
        throw new Error(`expected Local open call #${index} | received: ${calls.length} call(s)`);
      }
      return found;
    };
    return { open, call, claims: () => calls.map((entry) => entry.isolation) };
  }

  /** Lets the chain deadline lapse so the next attempt starts beside a stuck one. */
  function outlastChainDeadline(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 30));
  }

  // #925: before claims were reserved ahead of `open`, a second user arriving
  // while the first user's open was still pending read the owner binding as
  // empty, and both users ended up attested against one credential home.
  it('withholds attestation from a second user while the first Local open is pending', async () => {
    const opens = scriptedLocalOpen();
    const connector = createLocalRuntimeConnector({
      chainDeadlineMs: 25,
      open: opens.open,
    });

    const stuck = connector(localDefinition('user-1'), () => undefined, connectContext());
    const stuckOutcome = stuck.catch((error: unknown) => error);
    await outlastChainDeadline();
    const second = connector(localDefinition('user-2'), () => undefined, connectContext());
    await flushMicrotasks();
    opens.call(1).succeed();
    const secondConnection = await second;

    let lateCloseSettled = false;
    opens.call(0).succeed(async () => {
      await flushMicrotasks();
      lateCloseSettled = true;
    });
    const late = await stuckOutcome;

    try {
      expect(opens.claims()).toEqual(['single-user', 'withdrawn']);
      expect(secondConnection.identityAttested).toBe(false);
      expect(late).toMatchObject({
        code: RESERVED_ERROR_CODES.UNAVAILABLE,
        message: expect.stringContaining('withdrawn while it was connecting'),
      });
      // Awaited, not fired and forgotten: the rejection is the cleanup's end.
      expect({ lateCloseSettled }).toEqual({ lateCloseSettled: true });
    } finally {
      await secondConnection.close();
    }
  });

  it('surfaces the close failure of a withdrawn late open instead of the withdrawal', async () => {
    const opens = scriptedLocalOpen();
    const connector = createLocalRuntimeConnector({
      chainDeadlineMs: 25,
      open: opens.open,
    });

    const stuck = connector(localDefinition('user-1'), () => undefined, connectContext());
    const stuckOutcome = stuck.catch((error: unknown) => error);
    await outlastChainDeadline();
    const second = connector(localDefinition('user-2'), () => undefined, connectContext());
    await flushMicrotasks();
    opens.call(1).succeed();
    const secondConnection = await second;
    opens.call(0).succeed(() => Promise.reject(new Error('late close failed')));

    try {
      // The caller learns the attested connection may still be alive, rather
      // than a withdrawal message that implies it is gone.
      expect(await stuckOutcome).toMatchObject({ message: 'late close failed' });
    } finally {
      await secondConnection.close();
    }
  });

  it('keeps a pending same-user claim when an older attempt for that user fails late', async () => {
    const opens = scriptedLocalOpen();
    const connector = createLocalRuntimeConnector({
      chainDeadlineMs: 25,
      open: opens.open,
    });

    const older = connector(localDefinition('user-1'), () => undefined, connectContext());
    const olderOutcome = older.catch((error: unknown) => error);
    await outlastChainDeadline();
    const newer = connector(localDefinition('user-1'), () => undefined, connectContext());
    await flushMicrotasks();
    // The older attempt settling must release only its own generation. Were
    // claims keyed by user, this would free user-1's newer, still-open claim.
    opens.call(0).fail(new Error('older handshake failed'));
    expect(await olderOutcome).toMatchObject({ message: 'older handshake failed' });
    await outlastChainDeadline();
    const other = connector(localDefinition('user-2'), () => undefined, connectContext());
    await flushMicrotasks();
    opens.call(2).succeed();
    const otherConnection = await other;

    try {
      expect(opens.claims()).toEqual(['single-user', 'single-user', 'withdrawn']);
      expect(otherConnection.identityAttested).toBe(false);
    } finally {
      opens.call(1).succeed();
      await (await newer.catch(() => ({ close: () => undefined }))).close();
      await otherConnection.close();
    }
  });

  it('admits a late same-user success without disturbing the newer attested claim', async () => {
    const opens = scriptedLocalOpen();
    const connector = createLocalRuntimeConnector({
      chainDeadlineMs: 25,
      open: opens.open,
    });

    const older = connector(localDefinition('user-1'), () => undefined, connectContext());
    await outlastChainDeadline();
    const newer = connector(localDefinition('user-1'), () => undefined, connectContext());
    await flushMicrotasks();
    opens.call(1).succeed();
    const newerConnection = await newer;
    opens.call(0).succeed();
    const olderConnection = await older;

    try {
      expect(opens.claims()).toEqual(['single-user', 'single-user']);
      expect({
        older: olderConnection.identityAttested,
        newer: newerConnection.identityAttested,
      }).toEqual({ older: true, newer: true });
    } finally {
      await olderConnection.close();
      await newerConnection.close();
    }
  });

  it('releases a pending claim when its open fails after the chain deadline', async () => {
    const opens = scriptedLocalOpen();
    const connector = createLocalRuntimeConnector({
      chainDeadlineMs: 25,
      open: opens.open,
    });

    const failed = connector(localDefinition('user-1'), () => undefined, connectContext());
    const failedOutcome = failed.catch((error: unknown) => error);
    await outlastChainDeadline();
    opens.call(0).fail(new Error('handshake failed after the deadline'));
    expect(await failedOutcome).toMatchObject({ message: 'handshake failed after the deadline' });
    const next = connector(localDefinition('user-2'), () => undefined, connectContext());
    await flushMicrotasks();
    opens.call(1).succeed();
    const nextConnection = await next;

    try {
      expect(opens.claims()).toEqual(['single-user', 'single-user']);
      expect(nextConnection.identityAttested).toBe(true);
    } finally {
      await nextConnection.close();
    }
  });

  it('keeps withdrawn Local attestation withdrawn through the manager and a manifest refresh', async () => {
    const opens = scriptedLocalOpen();
    const local = createLocalRuntimeConnector({
      chainDeadlineMs: 25,
      open: opens.open,
    });
    // The connector's own outcomes, which the manager hides once it has
    // timed an attempt out and moved on.
    const attempts: Array<Promise<unknown>> = [];
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: (userId) => Promise.resolve(localDefinition(userId)),
      connectors: {
        'in-process': (definition, onUnavailable, context) => {
          const attempt = local(definition, onUnavailable, context);
          attempts.push(attempt.catch((error: unknown) => error));
          return attempt;
        },
      },
      connectDeadlinesMs: { 'in-process': 25 },
    });

    const wedged = manager.getClient('user-1', 'local').catch((error: unknown) => error);
    expect(await wedged).toMatchObject({ message: expect.stringContaining('timed out') });
    const second = manager.getClient('user-2', 'local');
    await flushMicrotasks();
    // A real hub session, so the claim the connector chose is the one the hub
    // enforces. The peer repeats an attestation in its hello and on health, as
    // a Local runtime asked to attest would; the withdrawal must outrank both.
    const runtime = await connectTestRuntime({
      manifest: { ...TEST_MANIFEST, identityIsolation: ATTESTED },
      externalAgentIsolation: opens.call(1).isolation,
      handlers: {
        'runtime.health': () => ({
          ...HEALTH_REPORT,
          externalAgents: {
            targets: [],
            identityIsolation: ATTESTED,
            liveSessionCount: 0,
            liveSessions: [],
          },
        }),
      },
    });
    opens.call(1).succeedWith({ client: runtime.client, close: () => runtime.close() });
    await second;
    let lateCloses = 0;
    opens.call(0).succeed(() => {
      lateCloses += 1;
    });
    await flushMicrotasks();
    const refreshed = await manager.refreshManifest('user-2', 'local');

    try {
      expect(opens.claims()).toEqual(['single-user', 'withdrawn']);
      expect({
        user1: manager.isIdentityAttested('user-1', 'local'),
        user2: manager.isIdentityAttested('user-2', 'local'),
      }).toEqual({ user1: false, user2: false });
      expect(refreshed.manifest?.identityIsolation).toBeUndefined();
      expect(await attempts[0]).toMatchObject({
        message: expect.stringContaining('withdrawn while it was connecting'),
      });
      expect(lateCloses).toBe(1);
    } finally {
      manager.disconnect('user-2', 'local');
      await runtime.close();
    }
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
    // The health report grants everything, but the handshake said this build
    // does not implement mcp. A refresh cannot upgrade that refusal.
    expect(manager.getStatus('user-1', 'devbox').manifest?.features.mcp).toBe(false);
    // This legacy handshake omitted newer optional fields, so the refreshed
    // manifest still changes when health fills those backward-compatible keys.
    expect(publishes).toBe(1);
  });

  it('reports a peer that withdrew external-agent consent, once', async () => {
    // The runtime closes its vendor sessions itself when its consent poll turns
    // the capability off, but that close emits no event and does not drop the
    // socket. This refresh is the only place the hub can learn of it, and the
    // sessions it still believes it owns would otherwise wait forever.
    const consented = capabilityManifestFromHealth(HEALTH_REPORT);
    const revoked: RuntimeHealthReport = {
      ...HEALTH_REPORT,
      allow: { ...HEALTH_REPORT.allow, externalAgents: false },
    };
    const probe = healthProbe(consented, () => Promise.resolve(revoked));
    const revocations: string[] = [];
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: () => Promise.resolve({ client: probe.client, close: () => undefined }),
      },
    });
    manager.onExternalAgentsRevoked((userId, environmentId) => {
      revocations.push(`${userId}:${environmentId}`);
    });

    await manager.connect('user-1', 'devbox');
    advanceSeconds(20);
    manager.refreshManifestIfStale('user-1', 'devbox');
    await flushMicrotasks();

    expect(revocations).toEqual(['user-1:devbox']);
    expect(manager.getStatus('user-1', 'devbox').manifest?.features.externalAgents).toBe(false);

    // A second refresh finding the same refusal is not a second revocation:
    // reaping again would be work with nothing left to reap.
    advanceSeconds(20);
    manager.refreshManifestIfStale('user-1', 'devbox');
    await flushMicrotasks();
    expect(revocations).toEqual(['user-1:devbox']);
  });

  it('reports terminal consent withdrawal once when the manifest refreshes', async () => {
    const consented = capabilityManifestFromHealth({ ...HEALTH_REPORT, terminal: true });
    const revoked: RuntimeHealthReport = {
      ...HEALTH_REPORT,
      terminal: false,
      allow: { ...HEALTH_REPORT.allow, shell: false },
    };
    const probe = healthProbe(consented, () => Promise.resolve(revoked));
    const revocations: string[] = [];
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: () => Promise.resolve({ client: probe.client, close: () => undefined }),
      },
    });
    manager.onTerminalsRevoked((userId, environmentId) => {
      revocations.push(`${userId}:${environmentId}`);
    });

    await manager.connect('user-1', 'devbox');
    await manager.refreshManifest('user-1', 'devbox');
    expect(revocations).toEqual(['user-1:devbox']);
    expect(manager.getStatus('user-1', 'devbox').manifest?.terminal).toBe(false);

    await manager.refreshManifest('user-1', 'devbox');
    expect(revocations).toEqual(['user-1:devbox']);
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
      Promise.reject(new RemoteError('TIMEOUT', 'no answer'))
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
   * are the minimum the SDK's launcher and `spawnRuntimeChild` need to tear the
   * connection down without throwing on a missing method.
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
    const error = outcome as RemoteError;

    // Before this fix, a missing wsl.exe surfaced as "The runtime binary was
    // not found at wsl.exe. Reinstall MangoStudio…" — true of a missing
    // sibling runtime binary, not of WSL itself being absent, and it sent the
    // user to the wrong fix.
    expect(error).toBeInstanceOf(RemoteError);
    expect(error.message).toContain('WSL could not be started');
    expect(error.message).not.toContain('Reinstall MangoStudio');
  });
});

describe('RuntimeConnectionManager — activity transitions', () => {
  it('records nothing for the first settled state after a fresh manager (the hub-restart guard)', async () => {
    const transitions: EnvironmentStateTransition[] = [];
    let finishConnect: ((connection: ManagedRuntimeConnection) => void) | undefined;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition()),
      connectors: {
        stdio: () =>
          new Promise((resolve) => {
            finishConnect = resolve;
          }),
      },
      recordTransition: (transition) => transitions.push(transition),
    });

    const connecting = manager.connect('user-1', 'devbox');
    await Promise.resolve();
    await Promise.resolve();
    // `connecting` settles to `undefined`: a step, not an outcome.
    expect(manager.getStatus('user-1', 'devbox').state).toBe('connecting');
    expect(transitions).toEqual([]);

    finishConnect?.(fakeConnection(() => undefined));
    await connecting;

    // The first settled state this entry ever reports has nothing to diff
    // against, so it must not be announced as a transition.
    expect(manager.getStatus('user-1', 'devbox').state).toBe('connected');
    expect(transitions).toEqual([]);
  });

  it('records exactly one connected → disconnected transition, named from the definition', async () => {
    const transitions: EnvironmentStateTransition[] = [];
    let finishConnect: ((connection: ManagedRuntimeConnection) => void) | undefined;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve({ ...definition(), name: 'Devbox display name' }),
      connectors: {
        stdio: () =>
          new Promise((resolve) => {
            finishConnect = resolve;
          }),
      },
      recordTransition: (transition) => transitions.push(transition),
    });

    const connecting = manager.connect('user-1', 'devbox');
    await Promise.resolve();
    await Promise.resolve();
    finishConnect?.(fakeConnection(() => undefined));
    await connecting;
    expect(transitions).toEqual([]);

    manager.disconnect('user-1', 'devbox');

    expect(transitions).toEqual([
      {
        userId: 'user-1',
        environmentId: 'devbox',
        environmentName: 'Devbox display name',
        previousState: 'connected',
        state: 'disconnected',
      },
    ]);
  });
});
