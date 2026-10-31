import { describe, expect, it } from 'bun:test';

import { type Port, RemoteError, RESERVED_ERROR_CODES, type Session } from '@mangostudio/protocol';
import type { ExitStatus, LaunchedPeer } from '@mangostudio/protocol/spawn';

import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  RuntimeConnectionManager,
  type RuntimeConnectionManagerOptions,
  type RuntimeEnvironmentConnector,
  type RuntimeEnvironmentResolver,
} from '../../../src/services/runtime-client/runtime-connection-manager';
import {
  RuntimeTerminationIncompleteError,
  spawnRuntimeChild,
  type SpawnRuntimeChildOptions,
} from '../../../src/services/runtime-client/spawn-runtime-child';
import { DeferredSpawnPort } from '../../support/mocks/deferred-spawn-port';
import { TEST_RUNTIME_MANIFEST } from '../../support/runtime-fixture';

/** A refused handshake whose one termination sequence settles only when released. */
class HeldHandshakePeer {
  readonly spawned = Promise.withResolvers<void>();
  readonly firstObservation = Promise.withResolvers<'termination-joined' | 'diagnostic-read'>();
  readonly #source = new DeferredSpawnPort();
  readonly #exit = Promise.withResolvers<ExitStatus>();
  readonly #termination = Promise.withResolvers<ExitStatus | undefined>();
  #runtime: Session | undefined;
  #started = false;
  terminationStarts = 0;
  connectionLosses = 0;

  readonly onClosed = (): void => {
    this.connectionLosses += 1;
  };

  readonly spawnPort = (): LaunchedPeer => {
    const peer = this.#source.spawnPort();
    peer.port.onClosed(this.#onPortClosed);
    const port: Port = {
      ...(peer.port.maxFrameBytes !== undefined ? { maxFrameBytes: peer.port.maxFrameBytes } : {}),
      send: (frame) => peer.port.send(frame),
      onFrame: (listener) => peer.port.onFrame(listener),
      onClosed: (listener) => peer.port.onClosed(listener),
      close: (code, reason) => {
        peer.port.close(code, reason);
        void this.#beginTermination();
      },
    };
    this.spawned.resolve();
    return {
      ...peer,
      port,
      exited: this.#exit.promise,
      stderrTail: () => {
        this.firstObservation.resolve('diagnostic-read');
        return 'refused handshake fixture';
      },
      terminate: () => {
        this.firstObservation.resolve('termination-joined');
        return this.#beginTermination();
      },
    };
  };

  refuse(): void {
    this.#runtime = this.#source.release(TEST_RUNTIME_MANIFEST, 'refused-release');
    if (!this.#runtime) throw new Error('expected a runtime session | received: none');
  }

  finish(status: ExitStatus | undefined): void {
    if (status !== undefined) this.#exit.resolve(status);
    this.#termination.resolve(status);
  }

  async dispose(): Promise<void> {
    this.finish(undefined);
    await this.#runtime?.close();
  }

  readonly #onPortClosed = (): void => {
    void this.#beginTermination();
  };

  #beginTermination(): Promise<ExitStatus | undefined> {
    if (!this.#started) {
      this.#started = true;
      this.terminationStarts += 1;
    }
    return this.#termination.promise;
  }
}

function runtimeOptions(peer: HeldHandshakePeer): SpawnRuntimeChildOptions {
  return {
    environmentId: 'devbox',
    launch: { command: 'fake-runtime', args: [] },
    workspaceBinding: null,
    hubVersion: 'hub-test',
    onClosed: peer.onClosed,
  };
}

/** Runs the real adapter through manager ownership without filesystem or process I/O. */
class FailedHandshakeConnector {
  readonly transitions: unknown[] = [];
  constructor(readonly peer: HeldHandshakePeer) {}

  readonly resolveEnvironment: RuntimeEnvironmentResolver = () =>
    Promise.resolve({
      id: 'devbox',
      userId: 'user-1',
      name: 'Devbox',
      transportKind: 'stdio',
      config: {},
      enabled: true,
    });

  readonly recordTransition: NonNullable<RuntimeConnectionManagerOptions['recordTransition']> = (
    transition
  ): void => {
    this.transitions.push(transition);
  };

  readonly connect: RuntimeEnvironmentConnector = async (_environment, onClosed, context) => {
    const connection = await spawnRuntimeChild(
      { ...runtimeOptions(this.peer), onClosed, signal: context.signal },
      { spawnPort: this.peer.spawnPort }
    );
    return {
      client: { manifest: TEST_RUNTIME_MANIFEST } as RuntimeClient,
      close: connection.close,
    };
  };
}

describe('failed handshake termination ownership', () => {
  it('joins the bounded termination before observing an ordinary handshake failure', async () => {
    const peer = new HeldHandshakePeer();
    const attempt = spawnRuntimeChild(runtimeOptions(peer), { spawnPort: peer.spawnPort }).catch(
      (error: unknown) => error
    );
    peer.refuse();
    try {
      expect(await peer.firstObservation.promise).toBe('termination-joined');
      peer.finish(undefined);
      expect(await attempt).toBeInstanceOf(RuntimeTerminationIncompleteError);
      expect(peer.terminationStarts).toBe(1);
      expect(peer.connectionLosses).toBe(0);
    } finally {
      await peer.dispose();
      await attempt;
    }
  });

  it('preserves the original handshake diagnostic when termination observes an exit', async () => {
    const peer = new HeldHandshakePeer();
    const attempt = spawnRuntimeChild(runtimeOptions(peer), { spawnPort: peer.spawnPort }).catch(
      (error: unknown) => error
    );
    peer.refuse();
    peer.finish({ code: 7, signal: null });
    try {
      const failure = await attempt;
      expect(failure).toBeInstanceOf(RemoteError);
      expect(failure).toMatchObject({
        code: RESERVED_ERROR_CODES.PROTOCOL_MISMATCH,
        details: { runtimeVersion: 'refused-release' },
      });
      expect((failure as Error).message).toContain('Reinstall MangoStudio');
      expect(peer.terminationStarts).toBe(1);
      expect(peer.connectionLosses).toBe(0);
    } finally {
      await peer.dispose();
    }
  });

  it('keeps manager shutdown waiting for an ordinary failed handshake termination', async () => {
    const peer = new HeldHandshakePeer();
    const connector = new FailedHandshakeConnector(peer);
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: connector.resolveEnvironment,
      connectors: { stdio: connector.connect },
      recordTransition: connector.recordTransition,
    });
    const connecting = manager.connect('user-1', 'devbox').catch((error: unknown) => error);
    await peer.spawned.promise;
    peer.refuse();
    let shutdown: Promise<unknown> | undefined;
    try {
      expect(await peer.firstObservation.promise).toBe('termination-joined');
      shutdown = manager.shutdown().catch((error: unknown) => error);
      peer.finish(undefined);
      expect(await shutdown).toBeInstanceOf(RuntimeTerminationIncompleteError);
      expect(await connecting).toMatchObject({
        code: RESERVED_ERROR_CODES.UNAVAILABLE,
        message: 'Runtime connection was closed.',
      });
      expect(peer.terminationStarts).toBe(1);
    } finally {
      await peer.dispose();
      await connecting;
      await (shutdown ?? manager.shutdown().catch((error: unknown) => error));
    }
  });
});
