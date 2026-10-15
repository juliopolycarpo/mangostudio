import { describe, expect, it, spyOn } from 'bun:test';
import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  type ManagedRuntimeConnection,
  RuntimeConnectionManager,
  type RuntimeConnectionManagerOptions,
  type RuntimeEnvironmentConnector,
} from '../../../src/services/runtime-client/runtime-connection-manager';

const definition = {
  id: 'devbox',
  userId: 'user-1',
  name: 'Devbox',
  transportKind: 'stdio' as const,
  config: {},
  enabled: true,
};

class DeferredConnection implements ManagedRuntimeConnection {
  client = { manifest: { features: {} } } as RuntimeClient;
  readonly closing = Promise.withResolvers<void>();
  readonly closeStarted = Promise.withResolvers<void>();
  closeCalls = 0;

  close(): void | Promise<void> {
    this.closeCalls += 1;
    this.closeStarted.resolve();
    return this.closing.promise;
  }
}

function closedConnection(): DeferredConnection {
  const connection = new DeferredConnection();
  connection.closing.resolve();
  return connection;
}

/** A connector that can ignore cancellation, fail late, or yield successive connections. */
class DeferredConnector {
  readonly started = Promise.withResolvers<AbortSignal>();
  readonly opening = Promise.withResolvers<ManagedRuntimeConnection>();
  readonly connections: ManagedRuntimeConnection[] = [];
  onUnavailable: () => void = () => undefined;
  onAbort: (() => void) | undefined;
  opens = 0;

  readonly open = (onUnavailable: () => void): Promise<ManagedRuntimeConnection> =>
    this.connect(definition, onUnavailable, {
      signal: new AbortController().signal,
      report: () => undefined,
    });

  readonly connect: RuntimeEnvironmentConnector = (_definition, onUnavailable, { signal }) => {
    this.opens += 1;
    this.onUnavailable = onUnavailable;
    if (this.onAbort) signal.addEventListener('abort', this.onAbort, { once: true });
    this.started.resolve(signal);
    const connection = this.connections.shift();
    return connection ? Promise.resolve(connection) : this.opening.promise;
  };
}

function managerWith(
  connector: DeferredConnector,
  options: Partial<RuntimeConnectionManagerOptions> = {}
): RuntimeConnectionManager {
  return new RuntimeConnectionManager({
    resolveEnvironment: () => Promise.resolve(definition),
    connectors: { stdio: connector.connect },
    ...options,
  });
}

/** Observe settled promises after the current microtask queue has drained. */
async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function failure(error: unknown): unknown {
  return error;
}

describe('Runtime connection teardown ownership', () => {
  it('awaits a cancelled opener until its asynchronous teardown rejects the open', async () => {
    const connector = new DeferredConnector();
    const manager = managerWith(connector);
    const attempt = manager.connect('user-1', 'devbox').catch(failure);
    const signal = await connector.started.promise;
    let released = false;
    const release = manager.closeAll().then(() => {
      released = true;
    });

    expect(signal.aborted).toBe(true);
    await nextTurn();
    expect(released).toBe(false);
    connector.opening.reject(new Error('child exited after cancellation'));
    await release;
    expect(await attempt).toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('awaits a late connection and its close without closing it twice', async () => {
    const connector = new DeferredConnector();
    const connection = new DeferredConnection();
    const manager = managerWith(connector, { openerReleaseTimeoutMs: 10 });
    const attempt = manager.connect('user-1', 'devbox').catch(failure);
    await connector.started.promise;
    let released = false;
    const release = manager.closeAll().then(() => {
      released = true;
    });
    connector.opening.resolve(connection);
    await connection.closeStarted.promise;
    // An acquired connection's close must outlive the opener cancellation budget.
    await Bun.sleep(30);
    expect(released).toBe(false);
    connection.closing.resolve();
    await release;
    await manager.closeAll();
    expect(await attempt).toMatchObject({ code: 'UNAVAILABLE' });
    expect(connection.closeCalls).toBe(1);
  });

  it('awaits an asynchronous close across concurrent callers and disconnect', async () => {
    const connector = new DeferredConnector();
    const connection = new DeferredConnection();
    connector.opening.resolve(connection);
    const manager = managerWith(connector);
    await manager.connect('user-1', 'devbox');
    manager.disconnect('user-1', 'devbox');
    const settled: number[] = [];
    const first = manager.closeAll().then(() => settled.push(1));
    const second = manager.closeAll().then(() => settled.push(2));
    await nextTurn();
    expect(settled).toEqual([]);
    expect(connection.closeCalls).toBe(1);
    connection.closing.resolve();
    await Promise.all([first, second]);
    expect(settled).toHaveLength(2);
  });

  it('includes a transport-loss close added after an earlier release snapshot', async () => {
    const connector = new DeferredConnector();
    const firstConnection = new DeferredConnection();
    const replacement = new DeferredConnection();
    connector.connections.push(firstConnection, replacement);
    const manager = managerWith(connector);
    await manager.connect('user-1', 'devbox');
    manager.disconnect('user-1', 'devbox');
    await manager.connect('user-1', 'devbox');
    connector.onUnavailable();
    let released = false;
    const shutdown = manager.shutdown().then(() => {
      released = true;
    });
    firstConnection.closing.resolve();
    await nextTurn();
    expect(released).toBe(false);
    replacement.closing.resolve();
    await shutdown;
    expect(firstConnection.closeCalls).toBe(1);
    expect(replacement.closeCalls).toBe(1);
  });

  it('retains an old opener while a replacement connects and is released', async () => {
    const connector = new DeferredConnector();
    const oldConnection = closedConnection();
    const replacement = closedConnection();
    const manager = managerWith(connector);
    const attempt = manager.connect('user-1', 'devbox').catch(failure);
    await connector.started.promise;
    manager.disconnect('user-1', 'devbox');
    connector.connections.push(replacement);
    await manager.connect('user-1', 'devbox');
    let released = false;
    const release = manager.closeAll().then(() => {
      released = true;
    });
    await nextTurn();
    expect(released).toBe(false);
    connector.opening.resolve(oldConnection);
    await release;
    expect(await attempt).toMatchObject({ code: 'UNAVAILABLE' });
    expect(oldConnection.closeCalls).toBe(1);
    expect(replacement.closeCalls).toBe(1);
    connector.connections.push(closedConnection());
    await manager.connect('user-1', 'devbox');
    await manager.closeAll();
    expect(connector.opens).toBe(3);
  });

  it('does not open a runtime when resolution completes after release', async () => {
    const resolving = Promise.withResolvers<typeof definition>();
    const connector = new DeferredConnector();
    const manager = managerWith(connector, { resolveEnvironment: () => resolving.promise });
    const attempt = manager.connect('user-1', 'devbox').catch(failure);
    const release = manager.closeAll();
    resolving.resolve(definition);
    await release;
    expect(await attempt).toMatchObject({ code: 'UNAVAILABLE' });
    expect(connector.opens).toBe(0);
  });

  it('keeps ownership after a public connect deadline expires', async () => {
    const connector = new DeferredConnector();
    const connection = new DeferredConnection();
    const manager = managerWith(connector, { connectDeadlinesMs: { stdio: 1 } });
    await expect(manager.connect('user-1', 'devbox')).rejects.toThrow('timed out after 1ms');
    let released = false;
    const release = manager.closeAll().then(() => {
      released = true;
    });
    connector.opening.resolve(connection);
    await connection.closeStarted.promise;
    await nextTurn();
    expect(released).toBe(false);
    connection.closing.resolve();
    await release;
  });

  it.each(['closeAll', 'shutdown'] as const)(
    '%s bounds an opener that never settles after its public deadline',
    async (method) => {
      const connector = new DeferredConnector();
      const manager = managerWith(connector, {
        connectDeadlinesMs: { stdio: 1 },
        openerReleaseTimeoutMs: 10,
      });
      await expect(manager.connect('user-1', 'devbox')).rejects.toThrow('timed out after 1ms');
      const warning = spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await manager[method]();
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining(
            'cancelled opener for user "user-1", environment "devbox" after 10ms'
          )
        );
        // Expiring the wait must preserve late-arrival cleanup and contain its failure.
        const late = new DeferredConnection();
        connector.opening.resolve(late);
        await late.closeStarted.promise;
        const release = manager.closeAll().catch(failure);
        const error = new Error('late close failed after opener budget');
        late.closing.reject(error);
        expect(await release).toBe(error);
        expect(late.closeCalls).toBe(1);
      } finally {
        warning.mockRestore();
      }
    }
  );

  it('waits for every close before reporting a synchronous close failure', async () => {
    const connector = new DeferredConnector();
    const first = closedConnection();
    const second = new DeferredConnection();
    const error = new Error('runtime close failed');
    spyOn(first, 'close').mockImplementation(() => {
      throw error;
    });
    connector.connections.push(first, second);
    const manager = managerWith(connector);
    await manager.connect('user-1', 'devbox');
    await manager.connect('user-1', 'other');
    let settled = false;
    const release = manager.closeAll().catch((caught: unknown) => {
      settled = true;
      return caught;
    });
    await nextTurn();
    expect(settled).toBe(false);
    second.closing.resolve();
    expect(await release).toBe(error);
  });

  it('tracks a lost connection whose close is still running', async () => {
    const connector = new DeferredConnector();
    const connection = new DeferredConnection();
    connector.opening.resolve(connection);
    const manager = managerWith(connector);
    await manager.connect('user-1', 'devbox');
    connector.onUnavailable();
    let released = false;
    const release = manager.closeAll().then(() => {
      released = true;
    });
    await nextTurn();
    expect(released).toBe(false);
    connection.closing.resolve();
    await release;
    expect(connection.closeCalls).toBe(1);
  });

  it('blocks admission during and after definitive shutdown, including reentrant aborts', async () => {
    const connector = new DeferredConnector();
    const reentered = Promise.withResolvers<unknown>();
    let resolutions = 0;
    const manager = managerWith(connector, {
      resolveEnvironment: () => {
        resolutions += 1;
        return Promise.resolve(definition);
      },
    });
    connector.onAbort = () => {
      void manager.connect('user-1', 'reentrant').catch(reentered.resolve);
    };
    const attempt = manager.connect('user-1', 'devbox').catch(failure);
    await connector.started.promise;
    const shutdown = manager.shutdown();
    expect(manager.shutdown()).toBe(shutdown);
    expect(await attempt).toMatchObject({ code: 'UNAVAILABLE' });
    expect(await reentered.promise).toMatchObject({
      code: 'UNAVAILABLE',
      message: expect.stringContaining('user "user-1", environment "reentrant"'),
    });
    const inbound = new DeferredConnector();
    const assertClosed = async () => {
      const calls = [
        manager.connect('user-1', 'devbox', { force: true }),
        manager.getClient('user-1', 'other'),
        manager.getExistingClient('user-1', 'devbox'),
        manager.connectInteractive('user-1', 'devbox'),
        manager.adopt('user-1', 'incoming', inbound.open),
      ];
      for (const result of await Promise.allSettled(calls)) {
        expect(result).toMatchObject({
          status: 'rejected',
          reason: { message: expect.stringContaining('expected a running manager') },
        });
      }
    };
    await assertClosed();
    connector.opening.resolve(closedConnection());
    await shutdown;
    await assertClosed();
    expect(resolutions).toBe(1);
    expect(inbound.opens).toBe(0);
  });

  it('refuses an inbound handshake whose definition resolves after shutdown', async () => {
    const resolving = Promise.withResolvers<typeof definition>();
    const connector = new DeferredConnector();
    const manager = managerWith(connector, { resolveEnvironment: () => resolving.promise });
    const inbound = new DeferredConnector();
    const attempt = manager.adopt('user-1', 'devbox', inbound.open).catch(failure);
    await manager.shutdown();
    resolving.resolve(definition);
    expect(await attempt).toMatchObject({ code: 'UNAVAILABLE' });
    expect(inbound.opens).toBe(0);
  });

  it('owns an inbound handshake and its late asynchronous close during shutdown', async () => {
    const connector = new DeferredConnector();
    const connection = new DeferredConnection();
    const manager = managerWith(new DeferredConnector());
    const attempt = manager.adopt('user-1', 'devbox', connector.open).catch(failure);
    await connector.started.promise;
    let shutDown = false;
    const shutdown = manager.shutdown().then(() => {
      shutDown = true;
    });
    connector.opening.resolve(connection);
    await connection.closeStarted.promise;
    await nextTurn();
    expect(shutDown).toBe(false);
    connection.closing.resolve();
    await shutdown;
    expect(await attempt).toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('awaits a superseded connection still closing when its replacement is released', async () => {
    const connector = new DeferredConnector();
    const connection = new DeferredConnection();
    connector.opening.resolve(connection);
    const manager = managerWith(connector);
    await manager.connect('user-1', 'devbox');
    const inbound = new DeferredConnector();
    inbound.opening.resolve(closedConnection());
    await manager.adopt('user-1', 'devbox', inbound.open);
    let released = false;
    const release = manager.shutdown().then(() => {
      released = true;
    });
    await nextTurn();
    expect(released).toBe(false);
    connection.closing.resolve();
    await release;
  });

  it('propagates a late close failure to every concurrent release', async () => {
    const connector = new DeferredConnector();
    const connection = new DeferredConnection();
    const error = new Error('late runtime close failed');
    const manager = managerWith(connector);
    const attempt = manager.connect('user-1', 'devbox').catch(failure);
    await connector.started.promise;
    const first = manager.closeAll().catch(failure);
    const second = manager.closeAll().catch(failure);
    connector.opening.resolve(connection);
    await connection.closeStarted.promise;
    connection.closing.reject(error);
    expect(await first).toBe(error);
    expect(await second).toBe(error);
    expect(await attempt).toMatchObject({ code: 'UNAVAILABLE' });
    expect(connection.closeCalls).toBe(1);
  });

  it('does not wait on a public connect blocked on the hosted-agent health read', async () => {
    const connector = new DeferredConnector();
    const healthStarted = Promise.withResolvers<void>();
    const health = Promise.withResolvers<never>();
    const connection = closedConnection();
    connection.client = {
      manifest: { features: { externalAgents: true } },
      health: () => {
        healthStarted.resolve();
        return health.promise;
      },
    } as unknown as RuntimeClient;
    connector.opening.resolve(connection);
    const manager = managerWith(connector);
    const attempt = manager.connect('user-1', 'devbox').catch(failure);
    await healthStarted.promise;
    await manager.shutdown();
    expect(connection.closeCalls).toBe(1);
    health.reject(new Error('runtime closed'));
    await attempt;
  });

  it.each(['close', 'abort'] as const)(
    'registers an inbound replacement before a superseded %s callback requests shutdown',
    async (trigger) => {
      const connector = new DeferredConnector();
      let shutdown: Promise<void> | undefined;
      const manager = managerWith(connector);
      const requestShutdown = () => {
        shutdown = manager.shutdown();
      };
      if (trigger === 'close') {
        const connection = closedConnection();
        spyOn(connection, 'close').mockImplementation(requestShutdown);
        connector.opening.resolve(connection);
      } else connector.onAbort = requestShutdown;
      const original = manager.connect('user-1', 'devbox').catch(failure);
      if (trigger === 'close') await original;
      else await connector.started.promise;
      const inbound = new DeferredConnector();
      const incoming = manager.adopt('user-1', 'devbox', inbound.open).catch(failure);
      await nextTurn();
      connector.opening.resolve(closedConnection());
      await original;
      await shutdown;
      expect(await incoming).toMatchObject({ code: 'UNAVAILABLE' });
      expect(inbound.opens).toBe(0);
    }
  );
});
