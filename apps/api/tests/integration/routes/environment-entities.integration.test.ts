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
import { RuntimeConnectionManager } from '../../../src/services/runtime-client/runtime-connection-manager';
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
  await getDb().deleteFrom('environments').where('userId', '=', TEST_USER.id).execute();
});

function createTestApp() {
  const repository = createEnvironmentRepository(getDb());
  const manager = new RuntimeConnectionManager({
    resolveEnvironment: async (userId, environmentId) => {
      const row = await repository.find(userId, environmentId);
      return row;
    },
    connectors: {},
  });
  const service = createEnvironmentService(repository, manager);
  const { app, restore } = createAuthenticatedApiTestApp(
    TEST_USER,
    createEnvironmentEntityRoutes(service)
  );
  restoreAuth = restore;
  return { app, repository };
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
});
