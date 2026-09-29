import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  getRuntimeConnectionManager,
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../../src/services/runtime-client/runtime-connection-manager';
import {
  registerRuntimeConnectionRelease,
  releaseRuntimeConnections,
  resetRuntimeConnectionReleaseForTests,
} from '../../../../src/services/runtime-client/runtime-connection-release';

afterEach(() => {
  setRuntimeConnectionManagerForTests(undefined);
  resetRuntimeConnectionReleaseForTests();
});

/** A manager with no connectors and no environments: it can never open a connection. */
function idleManager(): RuntimeConnectionManager {
  return new RuntimeConnectionManager({
    resolveEnvironment: () => Promise.resolve(null),
    connectors: {},
  });
}

describe('releaseRuntimeConnections', () => {
  test('does nothing when no connection manager was ever created', async () => {
    await expect(releaseRuntimeConnections()).resolves.toBeUndefined();
  });

  test('runs the release registered last', async () => {
    const released: string[] = [];
    registerRuntimeConnectionRelease(() => {
      released.push('first');
      return Promise.resolve();
    });
    registerRuntimeConnectionRelease(() => {
      released.push('second');
      return Promise.resolve();
    });

    await releaseRuntimeConnections();

    expect(released).toEqual(['second']);
  });

  test('surfaces a failing release to the caller', async () => {
    registerRuntimeConnectionRelease(() => Promise.reject(new Error('runtime child did not exit')));

    await expect(releaseRuntimeConnections()).rejects.toThrow('runtime child did not exit');
  });
});

describe('the connection manager registers its release', () => {
  test('when it creates the process singleton', async () => {
    const manager = getRuntimeConnectionManager();
    const closeAll = spyOn(manager, 'closeAll');

    await releaseRuntimeConnections();

    expect(closeAll).toHaveBeenCalledTimes(1);
  });

  test('when a test installs a manager in its place', async () => {
    const manager = idleManager();
    const closeAll = spyOn(manager, 'closeAll');
    setRuntimeConnectionManagerForTests(manager);

    await releaseRuntimeConnections();

    expect(closeAll).toHaveBeenCalledTimes(1);
  });
});
