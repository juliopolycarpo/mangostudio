import assert from 'node:assert/strict';
import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  type ManagedRuntimeConnection,
  RuntimeConnectionManager,
  type RuntimeEnvironmentConnector,
} from '../../../src/services/runtime-client/runtime-connection-manager';

/** A warmup opener that returns only after cancellation, with a separately gated close. */
class PendingRuntimeOpener {
  readonly started = Promise.withResolvers<void>();
  readonly cancelled = Promise.withResolvers<void>();
  readonly opened = Promise.withResolvers<ManagedRuntimeConnection>();
  readonly closing = Promise.withResolvers<void>();
  readonly closed = Promise.withResolvers<void>();
  readonly events: string[] = [];
  readonly connection: ManagedRuntimeConnection = {
    // A cancelled open must close without using the connection's client.
    client: {} as RuntimeClient,
    close: async () => {
      this.events.push('close-started');
      this.closing.resolve();
      await this.closed.promise;
      this.events.push('close-finished');
    },
  };
  readonly connect: RuntimeEnvironmentConnector = (_definition, _onUnavailable, context) => {
    this.events.push('open-started');
    context.signal.addEventListener(
      'abort',
      () => {
        this.events.push('open-cancelled');
        this.cancelled.resolve();
      },
      { once: true }
    );
    this.started.resolve();
    return this.opened.promise;
  };
}

/** Exercises the failure preload in its own process, preserving the parent test's prototype. */
async function runPendingShutdown(): Promise<void> {
  const opener = new PendingRuntimeOpener();
  const manager = new RuntimeConnectionManager({
    resolveEnvironment: async () => ({
      id: 'pending-warmup',
      userId: 'fixture-user',
      name: 'Pending warmup',
      transportKind: 'stdio',
      config: {},
      enabled: true,
    }),
    connectors: { stdio: opener.connect },
    recordTransition: () => undefined,
  });
  // Cancellation rejects the public connect before the raw opener/close settles.
  const connecting = manager.connect('fixture-user', 'pending-warmup').catch(() => undefined);
  try {
    await opener.started.promise;
    const shutdown = manager.shutdown().then(
      () => ({ error: '<resolved>' }),
      (error: unknown) => {
        opener.events.push('shutdown-rejected');
        return { error: error instanceof Error ? error.message : String(error) };
      }
    );
    assert.equal(
      await Promise.race([
        opener.cancelled.promise.then(() => 'cancelled'),
        shutdown.then(() => 'shutdown-settled'),
      ]),
      'cancelled',
      'expected pending opener cancellation before the fixture shutdown error'
    );

    opener.opened.resolve(opener.connection);
    assert.equal(
      await Promise.race([
        opener.closing.promise.then(() => 'closing'),
        shutdown.then(() => 'shutdown-settled'),
      ]),
      'closing',
      'expected the late connection to close before the fixture shutdown error'
    );
    assert.deepEqual(opener.events, ['open-started', 'open-cancelled', 'close-started']);

    opener.closed.resolve();
    assert.deepEqual(await shutdown, { error: 'fixture runtime teardown failed' });
    assert.deepEqual(opener.events, [
      'open-started',
      'open-cancelled',
      'close-started',
      'close-finished',
      'shutdown-rejected',
    ]);
    process.stdout.write(JSON.stringify({ events: opener.events }));
  } finally {
    // Even the intentionally red run releases every gate and its manager ownership.
    opener.opened.resolve(opener.connection);
    opener.closed.resolve();
    await manager.closeAll();
    await connecting;
  }
}

if (import.meta.main) await runPendingShutdown();
