import { afterEach, describe, expect, it } from 'bun:test';
import { createLocalRuntimeHost, serveRuntime } from '@mangostudio/runtime';
import { getDb } from '../../../src/db/database';
import { createEnvironmentService } from '../../../src/modules/environments/application/environment-service';
import { createEnvironmentRepository } from '../../../src/modules/environments/infrastructure/environment-repository';
import { connectHttpRuntime } from '../../../src/services/runtime-client/connect-http-runtime';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../src/services/runtime-client/runtime-connection-manager';
import {
  persistRuntimeToken,
  setRuntimeTokenStoreForTests,
} from '../../../src/services/runtime-client/runtime-token-secrets';
import { insertTestUser } from '../../support/factories';
import { InMemorySecretStore } from '../../support/mocks/mock-secret-store';

const TEST_USER = {
  id: 'http-runtime-user',
  name: 'HTTP Runtime User',
  email: 'http-runtime@mangostudio.test',
};

const handles: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.close();
  setRuntimeConnectionManagerForTests(undefined);
  setRuntimeTokenStoreForTests(undefined);
  await getDb().deleteFrom('environments').where('userId', '=', TEST_USER.id).execute();
  await getDb().deleteFrom('user').where('id', '=', TEST_USER.id).execute();
});

describe('Direct URL http runtime', () => {
  it('connects through the secret-store token and round-trips a request', async () => {
    await insertTestUser(TEST_USER);
    const store = new InMemorySecretStore();
    setRuntimeTokenStoreForTests(store);
    const token = 'integration-serve-token';
    const serve = serveRuntime({
      listen: { hostname: '127.0.0.1', port: 0 },
      token,
      createHost: () => createLocalRuntimeHost({ runtimeVersion: 'http-integration' }),
    });
    handles.push(serve);

    const repository = createEnvironmentRepository(getDb());
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: async (userId, environmentId) => repository.find(userId, environmentId),
      connectors: { http: connectHttpRuntime },
    });
    setRuntimeConnectionManagerForTests(manager);
    const service = createEnvironmentService(repository, manager, () => undefined, store);

    const created = await service.create(TEST_USER.id, {
      id: 'lan-box',
      name: 'LAN box',
      transportKind: 'http',
      config: { baseUrl: `http://127.0.0.1:${serve.port}` },
      token,
    });
    expect(created.hasRuntimeToken).toBe(true);
    expect(created.config).toEqual({ baseUrl: `http://127.0.0.1:${serve.port}` });

    const connected = await service.connect(TEST_USER.id, 'lan-box');
    expect(connected.status.state).toBe('connected');
    expect(connected.status.runtimeVersion).toBe('http-integration');

    const client = await manager.getClient(TEST_USER.id, 'lan-box');
    const result = await client.workspace.validate({ path: process.cwd() });
    expect(result).toMatchObject({ ok: true, resolvedPath: expect.any(String) });
  }, 20_000);

  it('refuses the old token after rotation', async () => {
    await insertTestUser(TEST_USER);
    const store = new InMemorySecretStore();
    setRuntimeTokenStoreForTests(store);
    const firstToken = 'first-serve-token';
    const secondToken = 'second-serve-token';

    const serve = serveRuntime({
      listen: { hostname: '127.0.0.1', port: 0 },
      token: secondToken,
      createHost: () => createLocalRuntimeHost({ runtimeVersion: 'http-rotation' }),
    });
    handles.push(serve);

    const repository = createEnvironmentRepository(getDb());
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: async (userId, environmentId) => repository.find(userId, environmentId),
      connectors: { http: connectHttpRuntime },
    });
    setRuntimeConnectionManagerForTests(manager);
    const service = createEnvironmentService(repository, manager, () => undefined, store);

    await service.create(TEST_USER.id, {
      id: 'rotate-box',
      name: 'Rotate box',
      transportKind: 'http',
      config: { baseUrl: `http://127.0.0.1:${serve.port}` },
      token: firstToken,
    });

    await expect(service.connect(TEST_USER.id, 'rotate-box')).rejects.toThrow();

    await service.update(TEST_USER.id, 'rotate-box', { token: secondToken });
    const connected = await service.connect(TEST_USER.id, 'rotate-box');
    expect(connected.status.state).toBe('connected');
  }, 20_000);

  it('persists a rotated token without rewriting the row config', async () => {
    await insertTestUser(TEST_USER);
    const store = new InMemorySecretStore();
    setRuntimeTokenStoreForTests(store);
    const repository = createEnvironmentRepository(getDb());
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: async () => null,
      connectors: {},
    });
    const service = createEnvironmentService(repository, manager, () => undefined, store);

    await service.create(TEST_USER.id, {
      id: 'token-only',
      name: 'Token only',
      transportKind: 'http',
      config: { baseUrl: 'http://127.0.0.1:1' },
      token: 'initial',
    });
    await persistRuntimeToken(TEST_USER.id, 'token-only', 'initial', store);

    const updated = await service.update(TEST_USER.id, 'token-only', { token: 'rotated' });
    expect(updated.hasRuntimeToken).toBe(true);
    expect(updated.config).toEqual({ baseUrl: 'http://127.0.0.1:1' });
  });
});
