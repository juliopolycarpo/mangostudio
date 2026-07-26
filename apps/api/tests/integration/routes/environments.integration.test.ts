import { afterEach, describe, expect, it } from 'bun:test';
import { RuntimeStatusListSchema, RuntimeStatusSchema } from '@mangostudio/shared/environments';
import { Value } from '@sinclair/typebox/value';
import { createRuntimeDetectionService } from '../../../src/modules/environments/application/runtime-detection';
import type { BinaryScanDeps } from '../../../src/modules/environments/domain/binary-scan';
import { NODE_RUNTIME_DEFINITION } from '../../../src/modules/environments/domain/runtime-definitions';
import { createEnvironmentRoutes } from '../../../src/modules/environments/http/environment-routes';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'environments-routes-user',
  name: 'Environments Routes User',
  email: 'environments-routes@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

function createTestRoutes() {
  let probeCount = 0;
  const definition = {
    ...NODE_RUNTIME_DEFINITION,
    wellKnownDirs: () => [],
    includeBareBinaryNames: false,
  };
  const createDeps = (): BinaryScanDeps => ({
    platform: 'linux',
    homeDir: '/home/tester',
    env: { PATH: '/node/bin' },
    pathExists: () => true,
    probeVersion: () => {
      probeCount += 1;
      return Promise.resolve('v22.13.0');
    },
    realpath: (path) => Promise.resolve(path),
  });
  const service = createRuntimeDetectionService({
    definitions: [definition],
    createDeps,
    now: () => 1_700_000_000_000,
  });

  return {
    routes: createEnvironmentRoutes(service),
    getProbeCount: () => probeCount,
  };
}

describe('environment runtime routes', () => {
  it('lists, reads, and force-probes authenticated runtime status', async () => {
    const { routes, getProbeCount } = createTestRoutes();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, routes);
    restoreAuth = restore;

    const list = await app.handle(new Request('http://localhost/environments/runtimes'));
    const listPayload = await list.json();
    const read = await app.handle(new Request('http://localhost/environments/runtimes/node'));
    const readPayload = await read.json();
    const force = await app.handle(
      new Request('http://localhost/environments/runtimes/node/probe', { method: 'POST' })
    );
    const forcePayload = await force.json();

    expect(list.status).toBe(200);
    expect(Value.Check(RuntimeStatusListSchema, listPayload)).toBe(true);
    expect(read.status).toBe(200);
    expect(Value.Check(RuntimeStatusSchema, readPayload)).toBe(true);
    expect(force.status).toBe(200);
    expect(Value.Check(RuntimeStatusSchema, forcePayload)).toBe(true);
    expect(getProbeCount()).toBe(2);
  });

  it('rejects unsupported ids before any runtime probe', async () => {
    const { routes, getProbeCount } = createTestRoutes();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, routes);
    restoreAuth = restore;

    const invalid = await app.handle(new Request('http://localhost/environments/runtimes/python'));
    const notImplemented = await app.handle(
      new Request('http://localhost/environments/runtimes/nvm')
    );

    expect(invalid.status).toBe(422);
    expect(notImplemented.status).toBe(404);
    expect(getProbeCount()).toBe(0);
  });

  it('requires authentication for every runtime route', async () => {
    const { routes, getProbeCount } = createTestRoutes();
    const app = createApiTestApp(routes);

    const list = await app.handle(new Request('http://localhost/environments/runtimes'));
    const read = await app.handle(new Request('http://localhost/environments/runtimes/node'));
    const force = await app.handle(
      new Request('http://localhost/environments/runtimes/node/probe', { method: 'POST' })
    );

    expect([list.status, read.status, force.status]).toEqual([401, 401, 401]);
    expect(getProbeCount()).toBe(0);
  });
});
