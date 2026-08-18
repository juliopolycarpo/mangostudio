/**
 * The connector's decisions before anything is spawned: what it refuses, what
 * it reports while it waits, and how a preparation failure reaches the card.
 *
 * The spawn itself needs a real engine and a real runtime binary, so it is
 * proven by the container e2e rather than mocked into a shape that would pass
 * whatever the engine actually does.
 */

import { describe, expect, it } from 'bun:test';
import { RuntimeRemoteError } from '@mangostudio/runtime';
import type { ContainerEnvironmentConfig } from '@mangostudio/shared/environments';
import { ContainerRuntimeSourceError } from '../../../../src/modules/environments/domain/container-runtime-source';
import {
  ContainerEngineError,
  type ContainerEngineService,
} from '../../../../src/modules/environments/infrastructure/container-engine';
import { connectContainerRuntime } from '../../../../src/services/runtime-client/connect-container-runtime';

const RUNTIME_BINARY = {
  path: '/home/j/.mango/runtime-cache/0.1.1/mangostudio-runtime-0.1.1-linux-x64',
  offlineCache: false,
} as const;

function engines(overrides: Partial<ContainerEngineService> = {}): ContainerEngineService & {
  readonly killed: string[];
} {
  const killed: string[] = [];
  return {
    detect: () => Promise.resolve({ available: true, engines: [] }),
    prepare: () => Promise.resolve('linux-x64' as const),
    kill: (_engine, name) => {
      killed.push(name);
      return Promise.resolve();
    },
    ...overrides,
    killed,
  };
}

function definition(config: ContainerEnvironmentConfig) {
  return { id: 'sandbox', config };
}

const noop = () => undefined;

describe('connectContainerRuntime refusals', () => {
  it('refuses a mount of the engine socket before touching the engine', async () => {
    let prepared = false;
    const service = engines({
      prepare: () => {
        prepared = true;
        return Promise.resolve('linux-x64' as const);
      },
    });

    const attempt = connectContainerRuntime(
      definition({
        image: 'node:22',
        mounts: [{ hostPath: '/var/run/docker.sock', containerPath: '/var/run/docker.sock' }],
      }),
      noop,
      undefined,
      { engines: service, resolveRuntimeBinary: () => Promise.resolve(RUNTIME_BINARY) }
    );

    await expect(attempt).rejects.toThrow(/way out of the container/);
    expect(prepared).toBe(false);
  });

  it('refuses a relative host path', async () => {
    const attempt = connectContainerRuntime(
      definition({ image: 'node:22', mounts: [{ hostPath: 'project', containerPath: '/work' }] }),
      noop,
      undefined,
      { engines: engines(), resolveRuntimeBinary: () => Promise.resolve(RUNTIME_BINARY) }
    );

    await expect(attempt).rejects.toThrow(/not absolute/);
  });
});

describe('connectContainerRuntime failure reporting', () => {
  it('carries an engine failure reason to the card', async () => {
    const service = engines({
      prepare: () =>
        Promise.reject(
          new ContainerEngineError('engine-unreachable', 'docker is installed but did not answer.')
        ),
    });

    try {
      await connectContainerRuntime(definition({ image: 'node:22' }), noop, undefined, {
        engines: service,
        resolveRuntimeBinary: () => Promise.resolve(RUNTIME_BINARY),
      });
      throw new Error('expected the connect to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeRemoteError);
      const remote = error as RuntimeRemoteError;
      expect(remote.code).toBe('RUNTIME_UNAVAILABLE');
      expect(remote.details?.containerFailureReason).toBe('engine-unreachable');
    }
  });

  it('reports a runtime the hub cannot produce as runtime-unavailable', async () => {
    try {
      await connectContainerRuntime(definition({ image: 'node:22' }), noop, undefined, {
        engines: engines(),
        resolveRuntimeBinary: () =>
          Promise.reject(new ContainerRuntimeSourceError('This checkout has no build to mount.')),
      });
      throw new Error('expected the connect to fail');
    } catch (error) {
      expect((error as RuntimeRemoteError).details?.containerFailureReason).toBe(
        'runtime-unavailable'
      );
      expect((error as Error).message).toMatch(/no build to mount/);
    }
  });

  it('prepares with the engine the environment chose, not the default', async () => {
    // Asserted on what the connector does rather than on a details field: the
    // engine reaches the card through the environment's own config, so the
    // observable decision is which engine gets prepared.
    let preparedWith: string | undefined;
    try {
      await connectContainerRuntime(
        definition({ image: 'node:22', engine: 'podman' }),
        noop,
        undefined,
        {
          engines: engines({
            prepare: (config) => {
              preparedWith = config.engine;
              return Promise.reject(new ContainerEngineError('engine-missing', 'no podman'));
            },
          }),
          resolveRuntimeBinary: () => Promise.resolve(RUNTIME_BINARY),
        }
      );
      throw new Error('expected the connect to fail');
    } catch (error) {
      expect(preparedWith).toBe('podman');
      expect((error as RuntimeRemoteError).details?.containerFailureReason).toBe('engine-missing');
    }
  });
});

describe('connectContainerRuntime progress', () => {
  it('reports a pull as its own phase, and only when one happens', async () => {
    const phases: string[] = [];
    const service = engines({
      prepare: (_config, hooks) => {
        hooks?.onPullStart?.();
        return Promise.reject(new ContainerEngineError('image-pull-failed', 'pull died'));
      },
    });

    await expect(
      connectContainerRuntime(
        definition({ image: 'node:22' }),
        noop,
        { report: (phase) => phases.push(phase) },
        { engines: service, resolveRuntimeBinary: () => Promise.resolve(RUNTIME_BINARY) }
      )
    ).rejects.toThrow();

    expect(phases).toEqual(['pulling']);
  });

  it('says nothing when the image is already on the machine', async () => {
    const phases: string[] = [];

    await expect(
      connectContainerRuntime(
        definition({ image: 'node:22' }),
        noop,
        { report: (phase) => phases.push(phase) },
        {
          engines: engines({
            prepare: () => Promise.reject(new ContainerEngineError('unknown', 'later failure')),
          }),
          resolveRuntimeBinary: () => Promise.resolve(RUNTIME_BINARY),
        }
      )
    ).rejects.toThrow();

    expect(phases).toEqual([]);
  });

  // #791: a launch that only worked because the release was unreachable and the
  // cache answered for it has to be visible, not silent. Spawn is stubbed: the
  // engine is not this test, and a missing `docker` waits out the handshake
  // instead of failing closed.
  it('reports a runtime that came from the cache without the release confirming it', async () => {
    const phases: string[] = [];

    await expect(
      connectContainerRuntime(
        definition({ image: 'node:22' }),
        noop,
        { report: (phase) => phases.push(phase) },
        {
          engines: engines(),
          resolveRuntimeBinary: () => Promise.resolve({ ...RUNTIME_BINARY, offlineCache: true }),
          spawn: () => Promise.reject(new Error('launch is not this test')),
        }
      )
    ).rejects.toThrow(/launch is not this test/);

    expect(phases).toEqual(['offline-cache']);
  });
});
