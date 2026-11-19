/**
 * The handshake as a named phase of a connect (#1047).
 *
 * A spawned child that has not said hello yet used to leave the environment on
 * a bare `connecting` for the whole handshake budget, so a slow cold start and
 * a wedged child looked the same. These tests drive the wait by hand through a
 * `DeferredSpawnPort` — a child whose hello arrives only when the test releases
 * it — and read what the manager reports in between.
 */

import { describe, expect, it } from 'bun:test';

import type { LaunchedPeer } from '@mangostudio/protocol/spawn';

import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  createLocalRuntimeConnector,
  type LocalRuntimeOpenOptions,
  type ManagedRuntimeConnection,
  RuntimeConnectionManager,
  type RuntimeEnvironmentConnector,
} from '../../../src/services/runtime-client/runtime-connection-manager';
import { spawnRuntimeChild } from '../../../src/services/runtime-client/spawn-runtime-child';
import { DeferredSpawnPort } from '../../support/mocks/deferred-spawn-port';
import { TEST_RUNTIME_MANIFEST } from '../../support/runtime-fixture';

/** Records the order of the launcher's spawn and the hub's handshake-start callback. */
class OrderedLaunch {
  readonly events: string[] = [];
  readonly peer = new DeferredSpawnPort();

  readonly spawnPort = (): LaunchedPeer => {
    this.events.push('spawned');
    return this.peer.spawnPort();
  };
  readonly onHandshakeStart = (): void => {
    this.events.push('handshake-start');
  };
}

/**
 * Polls on timers, not microtasks, so a condition that never holds fails with
 * its name instead of starving the event loop until the test times out.
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`expected ${what} within 1000ms | received: none`);
}

function stdioDefinition() {
  return {
    id: 'devbox',
    userId: 'user-1',
    name: 'Devbox',
    transportKind: 'stdio' as const,
    config: {},
    enabled: true,
  };
}

/** A stdio-shaped connector that spawns through the real adapter and reports its handshake. */
function reportingConnector(launch: DeferredSpawnPort): RuntimeEnvironmentConnector {
  return async (_definition, onClosed, context) => {
    const connection = await spawnRuntimeChild(
      {
        environmentId: 'devbox',
        launch: { command: 'fake-runtime', args: [] },
        workspaceBinding: null,
        hubVersion: 'hub-test',
        onClosed,
        onHandshakeStart: () => context.report('handshaking'),
        signal: context.signal,
      },
      { spawnPort: launch.spawnPort }
    );
    return {
      client: { manifest: TEST_RUNTIME_MANIFEST } as RuntimeClient,
      close: connection.close,
    };
  };
}

describe('spawnRuntimeChild handshake start', () => {
  it('fires once, after the spawn and before the hello is answered', async () => {
    const launch = new OrderedLaunch();
    const connecting = spawnRuntimeChild(
      {
        environmentId: 'devbox',
        launch: { command: 'fake-runtime', args: [] },
        workspaceBinding: null,
        hubVersion: 'hub-test',
        onClosed: () => undefined,
        onHandshakeStart: launch.onHandshakeStart,
      },
      { spawnPort: launch.spawnPort }
    );

    expect(launch.events).toEqual(['spawned', 'handshake-start']);

    launch.peer.release();
    await connecting;
    expect(launch.events).toEqual(['spawned', 'handshake-start']);
  });

  it('never fires for a launch cancelled before the spawn', async () => {
    const launch = new OrderedLaunch();
    const controller = new AbortController();
    controller.abort();

    await expect(
      spawnRuntimeChild(
        {
          environmentId: 'devbox',
          launch: { command: 'fake-runtime', args: [] },
          workspaceBinding: null,
          hubVersion: 'hub-test',
          onClosed: () => undefined,
          onHandshakeStart: launch.onHandshakeStart,
          signal: controller.signal,
        },
        { spawnPort: launch.spawnPort }
      )
    ).rejects.toMatchObject({ code: 'CANCELLED' });

    expect(launch.events).toEqual([]);
  });
});

describe('RuntimeConnectionManager handshaking phase', () => {
  it('reports handshaking while the child is silent and clears it once connected', async () => {
    const child = new DeferredSpawnPort();
    const published: boolean[] = [];
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(stdioDefinition()),
      connectors: { stdio: reportingConnector(child) },
      publish: () => {
        published.push(manager.getStatus('user-1', 'devbox').handshaking === true);
      },
    });

    const connecting = manager.connect('user-1', 'devbox');
    // `connect` resolves the definition before it spawns; wait for the spawn.
    await until(() => child.spawnCallCount > 0, 'a spawned child');

    expect(manager.getStatus('user-1', 'devbox')).toEqual({
      state: 'connecting',
      handshaking: true,
    });
    expect(published).toContain(true);

    child.release();
    await connecting;

    const connected = manager.getStatus('user-1', 'devbox');
    expect(connected.state).toBe('connected');
    expect(connected.handshaking).toBeUndefined();
    await manager.shutdown();
  });

  it('drops a failed handshake back to a plain error with no handshaking flag', async () => {
    const child = new DeferredSpawnPort();
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(stdioDefinition()),
      connectors: { stdio: reportingConnector(child) },
    });

    const connecting = manager.connect('user-1', 'devbox').catch((error: unknown) => error);
    await until(() => child.spawnCallCount > 0, 'a spawned child');
    expect(manager.getStatus('user-1', 'devbox').handshaking).toBe(true);

    manager.disconnect('user-1', 'devbox');
    await connecting;

    expect(manager.getStatus('user-1', 'devbox').handshaking).toBeUndefined();
    await manager.shutdown();
  });

  it('ends a container pull when the handshake starts', async () => {
    const gate = Promise.withResolvers<void>();
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve({ ...stdioDefinition(), transportKind: 'stdio' }),
      connectors: {
        stdio: async (_definition, _onClosed, { report }) => {
          report('pulling');
          report('handshaking');
          await gate.promise;
          return {
            client: { manifest: TEST_RUNTIME_MANIFEST } as RuntimeClient,
            close: () => undefined,
          };
        },
      },
    });

    const connecting = manager.connect('user-1', 'devbox');
    await until(() => manager.getStatus('user-1', 'devbox').handshaking === true, 'handshaking');

    expect(manager.getStatus('user-1', 'devbox')).toEqual({
      state: 'connecting',
      handshaking: true,
    });
    gate.resolve();
    await connecting;
    await manager.shutdown();
  });
});

describe('Local connector handshake report', () => {
  it('hands the attempt’s report to the opener so a Local spawn can name its handshake', async () => {
    const seen: LocalRuntimeOpenOptions[] = [];
    const connector = createLocalRuntimeConnector({
      open: (options): Promise<ManagedRuntimeConnection> => {
        seen.push(options);
        options.report?.('handshaking');
        return Promise.resolve({
          client: { manifest: TEST_RUNTIME_MANIFEST } as RuntimeClient,
          close: () => undefined,
        });
      },
    });
    const phases: string[] = [];

    await connector(
      {
        id: 'local',
        userId: 'user-1',
        name: 'Local',
        transportKind: 'in-process',
        config: {},
        enabled: true,
      },
      () => undefined,
      { report: (phase) => phases.push(phase), signal: new AbortController().signal }
    );

    expect(seen).toHaveLength(1);
    expect(phases).toEqual(['handshaking']);
  });
});
