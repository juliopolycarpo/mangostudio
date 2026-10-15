import { describe, expect, it } from 'bun:test';
import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  type ManagedRuntimeConnection,
  RuntimeConnectionManager,
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

function connection(close: ManagedRuntimeConnection['close']): ManagedRuntimeConnection {
  return { client: { manifest: { features: {} } } as RuntimeClient, close };
}

function managerWith(connector: RuntimeEnvironmentConnector): RuntimeConnectionManager {
  return new RuntimeConnectionManager({
    resolveEnvironment: () => Promise.resolve(definition),
    connectors: { stdio: connector },
  });
}

/** Observe settled promises after the current microtask queue has drained. */
async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('Runtime connection teardown ownership', () => {
  it('awaits a cancelled opener until its asynchronous teardown rejects the open', async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const teardown = Promise.withResolvers<void>();
    const manager = managerWith(async (_definition, _onUnavailable, { signal }) => {
      started.resolve(signal);
      await teardown.promise;
      throw new Error('child exited after cancellation');
    });
    const attempt = manager.connect('user-1', 'devbox').catch((error: unknown) => error);
    const signal = await started.promise;
    let released = false;
    const release = manager.closeAll().then(() => {
      released = true;
    });

    expect(signal.aborted).toBe(true);
    await nextTurn();
    expect(released).toBe(false);
    teardown.resolve();
    await release;
    expect(await attempt).toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('awaits a late connection and its close without closing it twice', async () => {
    const started = Promise.withResolvers<void>();
    const opening = Promise.withResolvers<ManagedRuntimeConnection>();
    const closing = Promise.withResolvers<void>();
    const closeStarted = Promise.withResolvers<void>();
    let closeCalls = 0;
    const manager = managerWith(() => {
      started.resolve();
      return opening.promise;
    });
    const attempt = manager.connect('user-1', 'devbox').catch((error: unknown) => error);
    await started.promise;
    let released = false;
    const release = manager.closeAll().then(() => {
      released = true;
    });
    opening.resolve(
      connection(() => {
        closeCalls += 1;
        closeStarted.resolve();
        return closing.promise;
      })
    );
    await closeStarted.promise;
    await nextTurn();
    expect(released).toBe(false);
    closing.resolve();
    await release;
    await manager.closeAll();
    expect(await attempt).toMatchObject({ code: 'UNAVAILABLE' });
    expect(closeCalls).toBe(1);
  });

  it('shares an asynchronous release across concurrent callers and disconnect', async () => {
    const closing = Promise.withResolvers<void>();
    let closeCalls = 0;
    const manager = managerWith(() =>
      Promise.resolve(
        connection(() => {
          closeCalls += 1;
          return closing.promise;
        })
      )
    );
    await manager.connect('user-1', 'devbox');
    manager.disconnect('user-1', 'devbox');
    const settled: number[] = [];
    const first = manager.closeAll().then(() => settled.push(1));
    const second = manager.closeAll().then(() => settled.push(2));
    await nextTurn();
    expect(settled).toEqual([]);
    expect(closeCalls).toBe(1);
    closing.resolve();
    await Promise.all([first, second]);
    expect(settled).toHaveLength(2);
  });

  it('retains an old opener while a replacement connects and is released', async () => {
    const started = Promise.withResolvers<void>();
    const old = Promise.withResolvers<ManagedRuntimeConnection>();
    let opens = 0;
    const closed: string[] = [];
    const manager = managerWith(() => {
      opens += 1;
      started.resolve();
      return opens === 1
        ? old.promise
        : Promise.resolve(
            connection(() => {
              closed.push('new');
            })
          );
    });
    const attempt = manager.connect('user-1', 'devbox').catch((error: unknown) => error);
    await started.promise;
    manager.disconnect('user-1', 'devbox');
    await manager.connect('user-1', 'devbox');
    let released = false;
    const release = manager.closeAll().then(() => {
      released = true;
    });
    await nextTurn();
    expect(released).toBe(false);
    old.resolve(
      connection(() => {
        closed.push('old');
      })
    );
    await release;
    expect(await attempt).toMatchObject({ code: 'UNAVAILABLE' });
    expect(closed.sort()).toEqual(['new', 'old']);
    await manager.connect('user-1', 'devbox');
    await manager.closeAll();
    expect(opens).toBe(3);
  });

  it('does not open a runtime when resolution completes after release', async () => {
    const resolving = Promise.withResolvers<typeof definition>();
    let opens = 0;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => resolving.promise,
      connectors: {
        stdio: () => {
          opens += 1;
          return Promise.resolve(connection(() => undefined));
        },
      },
    });
    const attempt = manager.connect('user-1', 'devbox').catch((error: unknown) => error);
    const release = manager.closeAll();
    resolving.resolve(definition);
    await release;
    expect(await attempt).toMatchObject({ code: 'UNAVAILABLE' });
    expect(opens).toBe(0);
  });

  it('keeps ownership after a public connect deadline expires', async () => {
    const opening = Promise.withResolvers<ManagedRuntimeConnection>();
    const closing = Promise.withResolvers<void>();
    const closeStarted = Promise.withResolvers<void>();
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => Promise.resolve(definition),
      connectors: { stdio: () => opening.promise },
      connectDeadlinesMs: { stdio: 1 },
    });
    await expect(manager.connect('user-1', 'devbox')).rejects.toThrow('timed out after 1ms');
    let released = false;
    const release = manager.closeAll().then(() => {
      released = true;
    });
    opening.resolve(
      connection(() => {
        closeStarted.resolve();
        return closing.promise;
      })
    );
    await closeStarted.promise;
    await nextTurn();
    expect(released).toBe(false);
    closing.resolve();
    await release;
  });

  it('waits for every close before reporting a synchronous close failure', async () => {
    const closing = Promise.withResolvers<void>();
    const failure = new Error('runtime close failed');
    let opens = 0;
    const manager = managerWith(() => {
      opens += 1;
      return Promise.resolve(
        connection(
          opens === 1
            ? () => {
                throw failure;
              }
            : () => closing.promise
        )
      );
    });
    await manager.connect('user-1', 'devbox');
    await manager.connect('user-1', 'other');
    let settled = false;
    const release = manager.closeAll().catch((error: unknown) => {
      settled = true;
      return error;
    });
    await nextTurn();
    expect(settled).toBe(false);
    closing.resolve();
    expect(await release).toBe(failure);
  });

  it('tracks a lost connection whose close is still running', async () => {
    const closing = Promise.withResolvers<void>();
    let unavailable: () => void = () => undefined;
    let closeCalls = 0;
    const manager = managerWith((_definition, onUnavailable) => {
      unavailable = onUnavailable;
      return Promise.resolve(
        connection(() => {
          closeCalls += 1;
          return closing.promise;
        })
      );
    });
    await manager.connect('user-1', 'devbox');
    unavailable();
    let released = false;
    const release = manager.closeAll().then(() => {
      released = true;
    });
    await nextTurn();
    expect(released).toBe(false);
    closing.resolve();
    await release;
    expect(closeCalls).toBe(1);
  });

  it('blocks admission during and after definitive shutdown, including reentrant aborts', async () => {
    const started = Promise.withResolvers<void>();
    const opening = Promise.withResolvers<ManagedRuntimeConnection>();
    const reentered = Promise.withResolvers<unknown>();
    let resolutions = 0;
    let adoptions = 0;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => {
        resolutions += 1;
        return Promise.resolve(definition);
      },
      connectors: {
        stdio: (_definition, _onUnavailable, { signal }) => {
          signal.addEventListener(
            'abort',
            () => {
              void manager.connect('user-1', 'reentrant').catch(reentered.resolve);
            },
            { once: true }
          );
          started.resolve();
          return opening.promise;
        },
      },
    });
    const attempt = manager.connect('user-1', 'devbox').catch((error: unknown) => error);
    await started.promise;
    const shutdown = manager.shutdown();
    expect(manager.shutdown()).toBe(shutdown);
    expect(await attempt).toMatchObject({ code: 'UNAVAILABLE' });
    expect(await reentered.promise).toMatchObject({ code: 'UNAVAILABLE' });
    const assertClosed = async () => {
      const calls = [
        manager.connect('user-1', 'devbox', { force: true }),
        manager.getClient('user-1', 'other'),
        manager.getExistingClient('user-1', 'devbox'),
        manager.connectInteractive('user-1', 'devbox'),
        manager.adopt('user-1', 'incoming', () => {
          adoptions += 1;
          return Promise.resolve(connection(() => undefined));
        }),
      ];
      const results = await Promise.allSettled(calls);
      expect(results.every((result) => result.status === 'rejected')).toBe(true);
    };
    await assertClosed();
    opening.resolve(connection(() => undefined));
    await shutdown;
    await assertClosed();
    expect(resolutions).toBe(1);
    expect(adoptions).toBe(0);
  });

  it('refuses an inbound handshake whose definition resolves after shutdown', async () => {
    const resolving = Promise.withResolvers<typeof definition>();
    let opens = 0;
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: () => resolving.promise,
      connectors: {},
    });
    const attempt = manager
      .adopt('user-1', 'devbox', () => {
        opens += 1;
        return Promise.resolve(connection(() => undefined));
      })
      .catch((error: unknown) => error);
    await manager.shutdown();
    resolving.resolve(definition);
    expect(await attempt).toMatchObject({ code: 'UNAVAILABLE' });
    expect(opens).toBe(0);
  });

  it('owns an inbound handshake and its late asynchronous close during shutdown', async () => {
    const started = Promise.withResolvers<void>();
    const opening = Promise.withResolvers<ManagedRuntimeConnection>();
    const closing = Promise.withResolvers<void>();
    const closeStarted = Promise.withResolvers<void>();
    const manager = managerWith(() => Promise.reject(new Error('must not dial')));
    const attempt = manager
      .adopt('user-1', 'devbox', () => {
        started.resolve();
        return opening.promise;
      })
      .catch((error: unknown) => error);
    await started.promise;
    let shutDown = false;
    const shutdown = manager.shutdown().then(() => {
      shutDown = true;
    });
    opening.resolve(
      connection(() => {
        closeStarted.resolve();
        return closing.promise;
      })
    );
    await closeStarted.promise;
    await nextTurn();
    expect(shutDown).toBe(false);
    closing.resolve();
    await shutdown;
    expect(await attempt).toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('awaits a superseded connection still closing when its replacement is released', async () => {
    const closing = Promise.withResolvers<void>();
    const manager = managerWith(() => Promise.resolve(connection(() => closing.promise)));
    await manager.connect('user-1', 'devbox');
    await manager.adopt('user-1', 'devbox', () => Promise.resolve(connection(() => undefined)));
    let released = false;
    const release = manager.shutdown().then(() => {
      released = true;
    });
    await nextTurn();
    expect(released).toBe(false);
    closing.resolve();
    await release;
  });

  it('propagates a late close failure to every concurrent release', async () => {
    const started = Promise.withResolvers<void>();
    const opening = Promise.withResolvers<ManagedRuntimeConnection>();
    const failure = new Error('late runtime close failed');
    const manager = managerWith(() => {
      started.resolve();
      return opening.promise;
    });
    const attempt = manager.connect('user-1', 'devbox').catch((error: unknown) => error);
    await started.promise;
    const first = manager.closeAll().catch((error: unknown) => error);
    const second = manager.closeAll().catch((error: unknown) => error);
    let closeCalls = 0;
    opening.resolve(
      connection(() => {
        closeCalls += 1;
        return Promise.reject(failure);
      })
    );
    expect(await first).toBe(failure);
    expect(await second).toBe(failure);
    expect(await attempt).toMatchObject({ code: 'UNAVAILABLE' });
    expect(closeCalls).toBe(1);
  });

  it('does not wait on a public connect blocked on the hosted-agent health read', async () => {
    const healthStarted = Promise.withResolvers<void>();
    const health = Promise.withResolvers<never>();
    let closed = false;
    const runtime = connection(() => {
      closed = true;
    });
    const client = {
      manifest: { features: { externalAgents: true } },
      health: () => {
        healthStarted.resolve();
        return health.promise;
      },
    } as unknown as RuntimeClient;
    const manager = managerWith(() => Promise.resolve({ ...runtime, client }));
    const attempt = manager.connect('user-1', 'devbox').catch((error: unknown) => error);
    await healthStarted.promise;
    await manager.shutdown();
    expect(closed).toBe(true);
    health.reject(new Error('runtime closed'));
    await attempt;
  });

  it.each(['close', 'abort'] as const)(
    'registers an inbound replacement before a superseded %s callback requests shutdown',
    async (trigger) => {
      const started = Promise.withResolvers<void>();
      const oldOpening = Promise.withResolvers<ManagedRuntimeConnection>();
      let shutdown: Promise<void> | undefined;
      let inboundOpens = 0;
      const manager = managerWith((_definition, _onUnavailable, { signal }) => {
        started.resolve();
        if (trigger === 'close') {
          return Promise.resolve(
            connection(() => {
              shutdown = manager.shutdown();
            })
          );
        }
        signal.addEventListener(
          'abort',
          () => {
            shutdown = manager.shutdown();
          },
          { once: true }
        );
        return oldOpening.promise;
      });
      const original = manager.connect('user-1', 'devbox').catch((error: unknown) => error);
      if (trigger === 'close') await original;
      else await started.promise;
      const incoming = manager
        .adopt('user-1', 'devbox', () => {
          inboundOpens += 1;
          return Promise.resolve(connection(() => undefined));
        })
        .catch((error: unknown) => error);
      await nextTurn();
      oldOpening.resolve(connection(() => undefined));
      await original;
      await shutdown;
      expect(await incoming).toMatchObject({ code: 'UNAVAILABLE' });
      expect(inboundOpens).toBe(0);
    }
  );
});
