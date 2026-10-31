/**
 * Cancellation for a stdio launch — exercised against a fake handshake rather
 * than a real process. `spawn-runtime-child.integration.test.ts` covers the
 * real spawn, handshake, and teardown path; this file's fake handshake is a
 * gate a test controls by hand, which a real child's timing cannot give one.
 */

import { describe, expect, it, spyOn } from 'bun:test';

import { CLOSE_CODES, type RemoteError } from '@mangostudio/protocol';
import type { LaunchedPeer, SpawnOptions } from '@mangostudio/protocol/spawn';
import { HUB_WORKSPACE_AUTHORIZE_METHOD } from '@mangostudio/shared/runtime-contract';

import { getDb } from '../../../src/db/database';
import type { HubWorkspaceBinding } from '../../../src/services/runtime-client/hub-workspace-authority';
import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  RuntimeConnectionManager,
  type RuntimeEnvironmentConnector,
} from '../../../src/services/runtime-client/runtime-connection-manager';
import { spawnRuntimeChild } from '../../../src/services/runtime-client/spawn-runtime-child';
import { insertTestChat, insertTestUser } from '../../support/factories';
import { DeferredSpawnPort } from '../../support/mocks/deferred-spawn-port';
import { TEST_RUNTIME_MANIFEST } from '../../support/runtime-fixture';

class IncompleteTerminationPeer extends DeferredSpawnPort {
  terminationCalls = 0;

  readonly launch = (): LaunchedPeer => {
    const peer = this.spawnPort();
    return {
      ...peer,
      terminate: () => {
        this.terminationCalls += 1;
        peer.port.close(CLOSE_CODES.RELEASED, 'terminated by the launcher');
        return Promise.resolve(undefined);
      },
    };
  };
}

/** Wires a controlled launched peer through the real adapter and manager callback. */
class ManagedSpawnPeer {
  runtime: ReturnType<DeferredSpawnPort['release']>;

  constructor(
    readonly peer: DeferredSpawnPort,
    readonly launch: () => LaunchedPeer = peer.spawnPort
  ) {}

  readonly resolveEnvironment = () =>
    Promise.resolve({
      id: 'devbox',
      userId: 'user-1',
      name: 'Devbox',
      transportKind: 'stdio' as const,
      config: {},
      enabled: true,
    });

  readonly connect: RuntimeEnvironmentConnector = async (_environment, onClosed, context) => {
    const connecting = spawnRuntimeChild(
      {
        environmentId: 'devbox',
        launch: { command: 'fake-runtime', args: [] },
        workspaceBinding: null,
        hubVersion: 'hub-test',
        onClosed,
        signal: context.signal,
      },
      { spawnPort: this.launch }
    );
    this.runtime = this.peer.release();
    const connection = await connecting;
    return {
      client: { manifest: TEST_RUNTIME_MANIFEST } as RuntimeClient,
      close: connection.close,
    };
  };

  readonly manager = new RuntimeConnectionManager({
    resolveEnvironment: this.resolveEnvironment,
    connectors: { stdio: this.connect },
  });

  async closeRuntime(): Promise<void> {
    if (!this.runtime) throw new Error('expected runtime session: connected | received: none');
    await this.runtime.close();
  }
}

/** Signals only after the manager has observed a rejected teardown. */
class RuntimeTeardownWarnings {
  readonly observed = Promise.withResolvers<void>();
  readonly messages: string[] = [];
  readonly capture = (message?: unknown, ...details: unknown[]): void => {
    if (message !== '[runtime] Releasing a runtime connection failed:') return;
    this.messages.push(String(details[0]));
    this.observed.resolve();
  };
  readonly spy = spyOn(console, 'warn').mockImplementation(this.capture);

  restore(): void {
    this.spy.mockRestore();
  }
}

describe('spawnRuntimeChild — incomplete termination', () => {
  it('retains a settled spontaneous teardown failure for later releases and shutdown', async () => {
    const peer = new IncompleteTerminationPeer();
    const fake = new ManagedSpawnPeer(peer, peer.launch);
    const warnings = new RuntimeTeardownWarnings();
    try {
      await fake.manager.connect('user-1', 'devbox');
      await fake.closeRuntime();
      await warnings.observed.promise;
      expect(warnings.messages).toEqual([expect.stringContaining('expected exit status')]);
      const first = await fake.manager.closeAll().catch((error: unknown) => error);
      expect(
        first,
        'expected retained incomplete-termination error after spontaneous close'
      ).toBeInstanceOf(Error);
      expect((first as Error).message).toContain('expected exit status');
      expect(await fake.manager.closeAll().catch((error: unknown) => error)).toBe(first);
      await fake.manager.connect('user-1', 'devbox', { force: true });
      expect(await fake.manager.shutdown().catch((error: unknown) => error)).toBe(first);
      expect(peer.terminationCalls).toBe(2);
    } finally {
      await fake.manager.shutdown().catch(() => undefined);
      warnings.restore();
    }
  });

  it('allows later release after a successful spontaneous teardown', async () => {
    const peer = new DeferredSpawnPort();
    const fake = new ManagedSpawnPeer(peer);
    const warnings = new RuntimeTeardownWarnings();
    try {
      await fake.manager.connect('user-1', 'devbox');
      await fake.closeRuntime();
      await expect(fake.manager.closeAll()).resolves.toBeUndefined();
      await expect(fake.manager.closeAll()).resolves.toBeUndefined();
      await expect(fake.manager.shutdown()).resolves.toBeUndefined();
      expect(peer.terminateCallCount).toBe(1);
      expect(warnings.messages).toEqual([]);
    } finally {
      await fake.manager.shutdown().catch(() => undefined);
      warnings.restore();
    }
  });

  it('reports incomplete termination when a handshake is cancelled', async () => {
    const fake = new IncompleteTerminationPeer();
    const controller = new AbortController();
    const attempt = spawnRuntimeChild(
      {
        environmentId: 'devbox',
        launch: { command: 'fake-runtime', args: [] },
        workspaceBinding: null,
        hubVersion: 'hub-test',
        onClosed: () => undefined,
        signal: controller.signal,
      },
      { spawnPort: fake.launch }
    );
    controller.abort();
    await expect(attempt).rejects.toThrow('expected exit status');
    expect(fake.terminationCalls).toBe(1);
  });

  it('reports incomplete termination when shutdown cancels a pending opening', async () => {
    const fake = new IncompleteTerminationPeer();
    const spawned = Promise.withResolvers<void>();
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () =>
        Promise.resolve({
          id: 'devbox',
          userId: 'user-1',
          name: 'Devbox',
          transportKind: 'stdio',
          config: {},
          enabled: true,
        }),
      connectors: {
        stdio: async (_environment, _onClosed, context) => {
          const connecting = spawnRuntimeChild(
            {
              environmentId: 'devbox',
              launch: { command: 'fake-runtime', args: [] },
              workspaceBinding: null,
              hubVersion: 'hub-test',
              onClosed: () => undefined,
              signal: context.signal,
            },
            {
              spawnPort: () => {
                const peer = fake.launch();
                spawned.resolve();
                return peer;
              },
            }
          );
          const connection = await connecting;
          return {
            client: { manifest: TEST_RUNTIME_MANIFEST } as RuntimeClient,
            close: connection.close,
          };
        },
      },
    });
    const connecting = manager.connect('user-1', 'devbox').catch((error: unknown) => error);
    await spawned.promise;
    await expect(manager.shutdown()).rejects.toThrow('expected exit status');
    await connecting;
    expect(fake.terminationCalls).toBe(1);
  });

  it('reports incomplete termination through manager shutdown', async () => {
    const fake = new IncompleteTerminationPeer();
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () =>
        Promise.resolve({
          id: 'devbox',
          userId: 'user-1',
          name: 'Devbox',
          transportKind: 'stdio',
          config: {},
          enabled: true,
        }),
      connectors: {
        stdio: async () => {
          const connecting = spawnRuntimeChild(
            {
              environmentId: 'devbox',
              launch: { command: 'fake-runtime', args: [] },
              workspaceBinding: null,
              hubVersion: 'hub-test',
              onClosed: () => undefined,
            },
            { spawnPort: fake.launch }
          );
          fake.release();
          const connection = await connecting;
          return {
            client: { manifest: TEST_RUNTIME_MANIFEST } as RuntimeClient,
            close: connection.close,
          };
        },
      },
    });
    await manager.connect('user-1', 'devbox');
    await expect(manager.shutdown()).rejects.toThrow('expected exit status');
    expect(fake.terminationCalls).toBe(1);
  });

  it('observes a spontaneous close failure once and retains it for close', async () => {
    const fake = new IncompleteTerminationPeer();
    const closed = Promise.withResolvers<void>();
    let notifications = 0;
    const previousLogs = process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
    process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = '1';
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const connecting = spawnRuntimeChild(
        {
          environmentId: 'devbox',
          launch: { command: 'fake-runtime', args: [] },
          workspaceBinding: null,
          hubVersion: 'hub-test',
          onClosed: () => {
            notifications += 1;
            closed.resolve();
          },
        },
        { spawnPort: fake.launch }
      );
      const runtime = fake.release();
      if (!runtime) throw new Error('expected runtime session | received: none');
      const connection = await connecting;
      await runtime.close();
      await closed.promise;
      await expect(connection.close()).rejects.toThrow('fake-runtime');
      await Promise.resolve();
      expect(notifications).toBe(1);
      expect(fake.terminationCalls).toBe(1);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('termination_incomplete'));
    } finally {
      errors.mockRestore();
      if (previousLogs === undefined) delete process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
      else process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = previousLogs;
    }
  });

  it('rejects repeated closes with the same failure while exit remains pending', async () => {
    const fake = new IncompleteTerminationPeer();
    const connecting = spawnRuntimeChild(
      {
        environmentId: 'devbox',
        launch: { command: 'fake-runtime', args: [] },
        workspaceBinding: null,
        hubVersion: 'hub-test',
        onClosed: () => undefined,
      },
      { spawnPort: fake.launch }
    );
    fake.release();
    const connection = await connecting;
    const first = await connection.close().catch((error: unknown) => error);
    expect(first).toBeInstanceOf(Error);
    expect((first as Error).message).toContain('fake-runtime');
    expect(await connection.close().catch((error: unknown) => error)).toBe(first);
    expect(fake.terminationCalls).toBe(1);
  });
});

describe('spawnRuntimeChild — cancellation', () => {
  it('keeps a failed handshake on the short stop budget', async () => {
    const fake = new DeferredSpawnPort();
    const controller = new AbortController();
    let launchOptions: SpawnOptions | undefined;

    const attempt = spawnRuntimeChild(
      {
        environmentId: 'devbox',
        launch: { command: 'fake-runtime', args: [] },
        workspaceBinding: null,
        hubVersion: 'hub-test',
        onClosed: () => undefined,
        signal: controller.signal,
      },
      {
        spawnPort: (options) => {
          launchOptions = options;
          return fake.spawnPort();
        },
      }
    );

    controller.abort();
    await attempt.catch(() => undefined);
    expect(launchOptions?.terminateGraceMs).toBe(2_000);
    expect(launchOptions?.killGraceMs).toBe(2_000);
    expect(launchOptions?.exitGraceMs).toBe(1_000);
    expect(fake.promotedTerminateGraceMs).toBeUndefined();
  });

  it('promotes a connected runtime to the 30-second total stop cap', async () => {
    const fake = new DeferredSpawnPort();
    const connectionPromise = spawnRuntimeChild(
      {
        environmentId: 'devbox',
        launch: { command: 'fake-runtime', args: [] },
        workspaceBinding: null,
        hubVersion: 'hub-test',
        onClosed: () => undefined,
      },
      { spawnPort: fake.spawnPort }
    );
    fake.release();
    const connection = await connectionPromise;
    expect(fake.promotedTerminateGraceMs).toBe(27_000);
    await connection.close();
  });

  it('reaps the child when cancelled mid-handshake, before a late answer arrives', async () => {
    const fake = new DeferredSpawnPort();
    const controller = new AbortController();

    const attempt = spawnRuntimeChild(
      {
        environmentId: 'devbox',
        launch: { command: 'fake-runtime', args: [] },
        workspaceBinding: null,
        hubVersion: 'hub-test',
        handshakeTimeoutMs: 30_000,
        onClosed: () => undefined,
        signal: controller.signal,
      },
      { spawnPort: fake.spawnPort }
    );

    controller.abort();
    const error = (await attempt.catch((caught: unknown) => caught)) as RemoteError;

    expect(error.code).toBe('CANCELLED');
    expect(fake.terminateCallCount).toBe(1);

    // Late arrival: releasing after the rejection already settled must not
    // resurrect anything. Awaiting the rejection above — not a sleep — is
    // what makes "before" and "after" here deterministic.
    fake.release();
    expect(fake.terminateCallCount).toBe(1);
  });

  it('refuses to spawn at all when the signal is already aborted', async () => {
    const fake = new DeferredSpawnPort();
    const controller = new AbortController();
    controller.abort();

    const error = (await spawnRuntimeChild(
      {
        environmentId: 'devbox',
        launch: { command: 'fake-runtime', args: [] },
        workspaceBinding: null,
        hubVersion: 'hub-test',
        onClosed: () => undefined,
        signal: controller.signal,
      },
      { spawnPort: fake.spawnPort }
    ).catch((caught: unknown) => caught)) as RemoteError;

    expect(error.code).toBe('CANCELLED');
    expect(fake.spawnCallCount).toBe(0);
    expect(fake.terminateCallCount).toBe(0);
  });
});

describe('spawnRuntimeChild — workspace binding', () => {
  /** What the spawned runtime hears back when it asks the hub about `workdir`. */
  async function askThroughSpawn(
    workspaceBinding: HubWorkspaceBinding | null,
    workdir: string
  ): Promise<unknown> {
    const fake = new DeferredSpawnPort();
    const connecting = spawnRuntimeChild(
      {
        environmentId: 'devbox',
        launch: { command: 'fake-runtime', args: [] },
        workspaceBinding,
        hubVersion: 'hub-test',
        onClosed: () => undefined,
      },
      { spawnPort: fake.spawnPort }
    );
    const runtime = fake.release();
    if (!runtime) throw new Error('expected a runtime-side session | received: none');
    const connection = await connecting;
    try {
      return await runtime.request(HUB_WORKSPACE_AUTHORIZE_METHOD, {
        canonicalPath: workdir,
        purpose: 'external-agent',
      });
    } finally {
      await connection.close();
    }
  }

  it('answers for the binding the launcher passed, and nothing for none', async () => {
    const owner = await insertTestUser();
    const chat = await insertTestChat(owner.id);
    const workdir = '/home/owner/spawned-project';
    await getDb()
      .updateTable('chats')
      .set({ environmentId: 'devbox', workdir })
      .where('id', '=', chat.id)
      .execute();

    expect(await askThroughSpawn({ userId: owner.id, environmentId: 'devbox' }, workdir)).toEqual({
      authorized: true,
    });
    expect(await askThroughSpawn({ userId: owner.id, environmentId: 'other' }, workdir)).toEqual({
      authorized: false,
    });
    expect(await askThroughSpawn(null, workdir)).toEqual({ authorized: false });
  });
});
