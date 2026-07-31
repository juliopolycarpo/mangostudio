import { afterEach, describe, expect, it } from 'bun:test';
import type {
  CreateEnvironmentBody,
  Environment,
  UpdateEnvironmentBody,
} from '@mangostudio/shared/environments';
import { getDb } from '../../../src/db/database';
import { createEnvironmentService } from '../../../src/modules/environments/application/environment-service';
import { createEnvironmentEntityRoutes } from '../../../src/modules/environments/http/environment-entity-routes';
import {
  type CreateEnvironmentRecord,
  createEnvironmentRepository,
  type UpdateEnvironmentRecord,
} from '../../../src/modules/environments/infrastructure/environment-repository';
import {
  createRealtimeBus,
  setRealtimeBusForTests,
} from '../../../src/services/realtime/realtime-bus';
import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  RuntimeConnectionManager,
  type RuntimeConnectionManagerOptions,
} from '../../../src/services/runtime-client/runtime-connection-manager';
import { insertTestUser } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'environment-entities-user',
  name: 'Environment Entities User',
  email: 'environment-entities@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await getDb().deleteFrom('chats').where('userId', '=', TEST_USER.id).execute();
  await getDb().deleteFrom('environments').where('userId', '=', TEST_USER.id).execute();
  await getDb().deleteFrom('user').where('id', '=', TEST_USER.id).execute();
  setRealtimeBusForTests(undefined);
});

function createTestApp(connectors: RuntimeConnectionManagerOptions['connectors'] = {}) {
  const repository = createEnvironmentRepository(getDb());
  const manager = new RuntimeConnectionManager({
    resolveEnvironment: async (userId, environmentId) => {
      const row = await repository.find(userId, environmentId);
      return row;
    },
    connectors,
  });
  const service = createEnvironmentService(repository, manager);
  const { app, restore } = createAuthenticatedApiTestApp(
    TEST_USER,
    createEnvironmentEntityRoutes(service)
  );
  restoreAuth = restore;
  return { app, repository, manager };
}

function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

describe('environment entity routes', () => {
  it('lists virtual Local and isolates persisted environments by user', async () => {
    const { app, repository } = createTestApp();
    const other: CreateEnvironmentRecord = {
      id: 'other-box',
      userId: 'other-user',
      name: 'Other box',
      transportKind: 'stdio',
      config: {},
      enabled: true,
    };
    await repository.create(other);

    const response = await app.handle(new Request('http://localhost/environments'));
    const payload = (await response.json()) as Environment[];

    expect(response.status).toBe(200);
    expect(payload).toEqual([
      {
        id: 'local',
        name: 'Local',
        transportKind: 'in-process',
        config: {},
        enabled: true,
        virtual: true,
        createdAt: null,
        updatedAt: null,
        status: { state: 'disconnected' },
      },
    ]);
  });

  it('creates, updates, reads, and removes a user-owned environment', async () => {
    const { app } = createTestApp();
    const createBody: CreateEnvironmentBody = {
      id: 'dev-box',
      name: 'Dev box',
      transportKind: 'stdio',
      config: { binaryPath: '/opt/mango-runtime', cwd: '/workspace' },
    };
    const created = await app.handle(
      new Request('http://localhost/environments', jsonRequest('POST', createBody))
    );
    expect(created.status).toBe(201);

    const updateBody: UpdateEnvironmentBody = {
      name: 'Build box',
      config: { binaryPath: '/opt/mango-runtime' },
      enabled: false,
    };
    const updated = await app.handle(
      new Request('http://localhost/environments/dev-box', jsonRequest('PUT', updateBody))
    );
    const updatedPayload = (await updated.json()) as Environment;
    expect(updated.status).toBe(200);
    expect(updatedPayload).toMatchObject({
      id: 'dev-box',
      name: 'Build box',
      config: { binaryPath: '/opt/mango-runtime' },
      enabled: false,
      virtual: false,
    });

    const read = await app.handle(new Request('http://localhost/environments/dev-box'));
    expect(read.status).toBe(200);

    const removed = await app.handle(
      new Request('http://localhost/environments/dev-box', jsonRequest('DELETE'))
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ success: true });

    const missing = await app.handle(new Request('http://localhost/environments/dev-box'));
    expect(missing.status).toBe(404);
  });

  it('validates transport config on create and update', async () => {
    const { app, repository } = createTestApp();
    const invalidCreate = await app.handle(
      new Request(
        'http://localhost/environments',
        jsonRequest('POST', {
          id: 'unsafe',
          name: 'Unsafe',
          transportKind: 'stdio',
          config: { command: 'sh -c arbitrary' },
        })
      )
    );
    expect(invalidCreate.status).toBe(422);

    await repository.create({
      id: 'safe',
      userId: TEST_USER.id,
      name: 'Safe',
      transportKind: 'stdio',
      config: {},
      enabled: true,
    });
    const invalidUpdate: UpdateEnvironmentRecord = { config: { command: 'unsafe' } };
    const update = await app.handle(
      new Request('http://localhost/environments/safe', jsonRequest('PUT', invalidUpdate))
    );
    expect(update.status).toBe(400);
    expect(await update.json()).toMatchObject({ code: 'VALIDATION' });
  });

  it('keeps Local virtual and immutable', async () => {
    const { app } = createTestApp();
    const create = await app.handle(
      new Request(
        'http://localhost/environments',
        jsonRequest('POST', {
          id: 'local',
          name: 'Replacement',
          transportKind: 'stdio',
          config: {},
        })
      )
    );
    const disable = await app.handle(
      new Request('http://localhost/environments/local', jsonRequest('PUT', { enabled: false }))
    );
    const remove = await app.handle(
      new Request('http://localhost/environments/local', jsonRequest('DELETE'))
    );

    expect(create.status).toBe(409);
    expect(disable.status).toBe(409);
    expect(remove.status).toBe(409);
  });

  it('rejects removal while a chat still references the environment', async () => {
    const { app, repository } = createTestApp();
    await repository.create({
      id: 'active-box',
      userId: TEST_USER.id,
      name: 'Active box',
      transportKind: 'stdio',
      config: {},
      enabled: true,
    });
    await insertTestUser(TEST_USER);
    await getDb()
      .insertInto('chats')
      .values({
        id: 'environment-chat',
        title: 'Environment chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: TEST_USER.id,
        environmentId: 'active-box',
      })
      .execute();

    const response = await app.handle(
      new Request('http://localhost/environments/active-box', jsonRequest('DELETE'))
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'CONFLICT',
      error: 'Environment "active-box" is still used by one or more chats.',
    });
    expect(await repository.find(TEST_USER.id, 'active-box')).not.toBeNull();
  });

  it('drops a live connection when the transport it was opened from changes', async () => {
    let closeCalls = 0;
    const { app, manager } = createTestApp({
      stdio: () =>
        Promise.resolve({
          client: {
            manifest: {
              platform: process.platform,
              arch: process.arch,
              pathStyle: process.platform === 'win32' ? 'win32' : 'posix',
              homeDir: '/home/test',
              shells: ['bash'],
              git: { available: true },
              features: {
                tools: true,
                git: true,
                probing: false,
                mcp: false,
                library: false,
                checkpoints: true,
              },
            },
          } as RuntimeClient,
          close: () => {
            closeCalls += 1;
          },
        }),
    });

    const createBody: CreateEnvironmentBody = {
      id: 'repoint-box',
      name: 'Repoint box',
      transportKind: 'stdio',
      config: { binaryPath: '/opt/mango-runtime' },
    };
    await app.handle(new Request('http://localhost/environments', jsonRequest('POST', createBody)));
    const connected = await app.handle(
      new Request('http://localhost/environments/repoint-box/connect', jsonRequest('POST'))
    );
    expect(connected.status).toBe(200);
    expect(manager.getStatus(TEST_USER.id, 'repoint-box').state).toBe('connected');

    const repointed = await app.handle(
      new Request(
        'http://localhost/environments/repoint-box',
        jsonRequest('PUT', {
          config: { binaryPath: '/opt/other-runtime' },
        } satisfies UpdateEnvironmentBody)
      )
    );

    // Otherwise the response advertises the new binary while every tool call
    // keeps reaching the process opened from the old one.
    expect(repointed.status).toBe(200);
    expect((await repointed.json()) as Environment).toMatchObject({
      config: { binaryPath: '/opt/other-runtime' },
      status: { state: 'disconnected' },
    });
    expect(closeCalls).toBe(1);
  });

  it('keeps a live connection when a rejected update persists nothing', async () => {
    let closeCalls = 0;
    const { app, manager } = createTestApp({
      stdio: () =>
        Promise.resolve({
          client: {
            manifest: {
              platform: process.platform,
              arch: process.arch,
              pathStyle: process.platform === 'win32' ? 'win32' : 'posix',
              homeDir: '/home/test',
              shells: ['bash'],
              git: { available: true },
              features: {
                tools: true,
                git: true,
                probing: false,
                mcp: false,
                library: false,
                checkpoints: true,
              },
            },
          } as RuntimeClient,
          close: () => {
            closeCalls += 1;
          },
        }),
    });

    await app.handle(
      new Request(
        'http://localhost/environments',
        jsonRequest('POST', {
          id: 'stable-box',
          name: 'Stable box',
          transportKind: 'stdio',
          config: { binaryPath: '/opt/mango-runtime' },
        } satisfies CreateEnvironmentBody)
      )
    );
    await app.handle(
      new Request('http://localhost/environments/stable-box/connect', jsonRequest('POST'))
    );

    const rejected = await app.handle(
      new Request(
        'http://localhost/environments/stable-box',
        jsonRequest('PUT', { config: { binaryPath: 42 } })
      )
    );

    expect(rejected.status).toBe(400);
    expect(closeCalls).toBe(0);
    expect(manager.getStatus(TEST_USER.id, 'stable-box').state).toBe('connected');
  });

  it('surfaces unavailable transport connections as a stable conflict', async () => {
    const { app, repository } = createTestApp();
    await repository.create({
      id: 'future',
      userId: TEST_USER.id,
      name: 'Future',
      transportKind: 'stdio',
      config: {},
      enabled: true,
    });

    const response = await app.handle(
      new Request('http://localhost/environments/future/connect', jsonRequest('POST'))
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'CONFLICT',
      error: 'The stdio environment transport is not available yet.',
    });
  });

  it('reports a connect against a vanished environment as missing, not conflicting', async () => {
    const { app, repository } = createTestApp({
      stdio: async (definition) => {
        // Stands in for the window between the route's existence check and the
        // manager's own lookup: the row is gone by the time the transport opens.
        await repository.remove(TEST_USER.id, definition.id);
        throw new Error('runtime exited');
      },
    });
    await repository.create({
      id: 'vanishing',
      userId: TEST_USER.id,
      name: 'Vanishing',
      transportKind: 'stdio',
      config: {},
      enabled: true,
    });

    const response = await app.handle(
      new Request('http://localhost/environments/vanishing/connect', jsonRequest('POST'))
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('publishes user-scoped invalidations after persisted entity changes', async () => {
    const bus = createRealtimeBus();
    const events: string[] = [];
    setRealtimeBusForTests(bus);
    bus.subscribe(TEST_USER.id, (event) => events.push(event.topic));
    const { app } = createTestApp();

    await app.handle(
      new Request(
        'http://localhost/environments',
        jsonRequest('POST', {
          id: 'event-box',
          name: 'Event box',
          transportKind: 'stdio',
          config: {},
        })
      )
    );
    await app.handle(
      new Request(
        'http://localhost/environments/event-box',
        jsonRequest('PUT', { name: 'Renamed box' })
      )
    );
    await app.handle(new Request('http://localhost/environments/event-box', jsonRequest('DELETE')));

    expect(events).toEqual(['environments', 'environments', 'environments']);
  });
});
