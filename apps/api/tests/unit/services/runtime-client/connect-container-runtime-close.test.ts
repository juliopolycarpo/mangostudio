import { describe, expect, it } from 'bun:test';

import type { ContainerEngineService } from '../../../../src/modules/environments/infrastructure/container-engine';
import {
  connectContainerRuntime,
  type ConnectContainerRuntimeDeps,
} from '../../../../src/services/runtime-client/connect-container-runtime';
import {
  RuntimeTerminationIncompleteError,
  type SpawnedRuntimeConnection,
  spawnRuntimeChild,
  type SpawnRuntimeChildOptions,
} from '../../../../src/services/runtime-client/spawn-runtime-child';
import { DeferredSpawnPort } from '../../../support/mocks/deferred-spawn-port';
import { TEST_RUNTIME_MANIFEST } from '../../../support/runtime-fixture';

/** A connected runtime with a failed close and a separately controlled engine backstop. */
class FailedContainerClose implements ConnectContainerRuntimeDeps {
  readonly firstStep = Promise.withResolvers<'backstop-started' | 'close-settled'>();
  readonly closeError = new RuntimeTerminationIncompleteError('engine-client', 'sandbox');
  readonly killed: Array<Parameters<ContainerEngineService['kill']>> = [];
  readonly #peer = new DeferredSpawnPort();
  readonly #kill = Promise.withResolvers<void>();
  #connection: SpawnedRuntimeConnection | undefined;
  options: SpawnRuntimeChildOptions | undefined;
  holdKill = false;
  closeSettled = false;
  closeCalls = 0;

  readonly detect: ContainerEngineService['detect'] = () =>
    Promise.resolve({ available: true, engines: [] });

  readonly prepare: ContainerEngineService['prepare'] = () => Promise.resolve('linux-x64');

  readonly kill: ContainerEngineService['kill'] = (engine, name) => {
    this.killed.push([engine, name]);
    this.firstStep.resolve('backstop-started');
    return this.holdKill ? this.#kill.promise : Promise.resolve();
  };

  readonly engines: ContainerEngineService = {
    detect: this.detect,
    prepare: this.prepare,
    kill: this.kill,
  };

  readonly resolveRuntimeBinary: ConnectContainerRuntimeDeps['resolveRuntimeBinary'] = () =>
    Promise.resolve({ path: process.execPath, offlineCache: false });

  readonly spawn: ConnectContainerRuntimeDeps['spawn'] = async (options) => {
    this.options = options;
    const connecting = spawnRuntimeChild(options, { spawnPort: this.#peer.spawnPort });
    this.#peer.release(TEST_RUNTIME_MANIFEST, options.hubVersion);
    this.#connection = await connecting;
    return { hub: this.#connection.hub, close: this.failClose };
  };

  readonly failClose = (): Promise<void> => {
    this.closeCalls += 1;
    return Promise.reject(this.closeError);
  };

  readonly observeClose = (error: unknown): unknown => {
    this.closeSettled = true;
    this.firstStep.resolve('close-settled');
    return error;
  };

  finishKill(reject: boolean): void {
    if (reject) this.#kill.reject(new Error('controlled engine backstop failure'));
    else this.#kill.resolve();
  }

  async dispose(): Promise<void> {
    this.finishKill(false);
    await this.#connection?.close();
  }
}

const onUnavailable = () => undefined;

describe('container close failure backstop', () => {
  for (const backstopRejects of [false, true]) {
    it(`awaits the ${backstopRejects ? 'rejecting' : 'successful'} backstop after close failure`, async () => {
      const fixture = new FailedContainerClose();
      const engine = backstopRejects ? 'docker' : 'podman';
      let closing: Promise<unknown> | undefined;
      try {
        const connection = await connectContainerRuntime(
          { id: 'sandbox', userId: 'test-user', config: { image: 'node:22', engine } },
          onUnavailable,
          undefined,
          fixture
        );
        fixture.holdKill = true;
        closing = Promise.resolve(connection.close()).catch(fixture.observeClose);

        expect(await fixture.firstStep.promise).toBe('backstop-started');
        // An unawaited close rejection must be observable before releasing the backstop.
        await Bun.sleep(0);
        expect(fixture.closeSettled).toBe(false);
        const args = fixture.options?.launch.args ?? [];
        const name = args[args.indexOf('--name') + 1];
        expect(name).toBeString();
        expect(fixture.killed).toEqual([[engine, name]]);

        fixture.finishKill(backstopRejects);
        expect(await closing).toBe(fixture.closeError);
        expect(fixture.closeCalls).toBe(1);
      } finally {
        fixture.finishKill(false);
        await closing;
        await fixture.dispose();
      }
    });
  }
});
