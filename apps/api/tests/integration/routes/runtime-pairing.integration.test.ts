import { afterEach, describe, expect, it } from 'bun:test';
import type { RuntimePairingIssue, RuntimePairingStatus } from '@mangostudio/shared/environments';
import { getDb } from '../../../src/db/database';
import { createEnvironmentService } from '../../../src/modules/environments/application/environment-service';
import { createRuntimePairingService } from '../../../src/modules/environments/application/runtime-pairing-service';
import { createEnvironmentEntityRoutes } from '../../../src/modules/environments/http/environment-entity-routes';
import { createEnvironmentRepository } from '../../../src/modules/environments/infrastructure/environment-repository';
import { createRuntimePairingRepository } from '../../../src/modules/environments/infrastructure/runtime-pairing-repository';
import { RuntimeConnectionManager } from '../../../src/services/runtime-client/runtime-connection-manager';
import { insertTestUser } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'runtime-pairing-user',
  name: 'Runtime Pairing User',
  email: 'runtime-pairing@mangostudio.test',
};

const PUBLIC_URL = 'https://hub.mangostudio.test';

let restoreAuth: (() => void) | null = null;

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await getDb().deleteFrom('runtime_pairing_tokens').where('userId', '=', TEST_USER.id).execute();
  await getDb().deleteFrom('environments').where('userId', '=', TEST_USER.id).execute();
  await getDb().deleteFrom('user').where('id', '=', TEST_USER.id).execute();
});

function createTestApp(options: { readonly publicUrl?: string } = {}) {
  const environments = createEnvironmentRepository(getDb());
  const repository = createRuntimePairingRepository(getDb());
  const manager = new RuntimeConnectionManager({
    resolveEnvironment: (userId, environmentId) => environments.find(userId, environmentId),
    connectors: {},
  });
  const pairing = createRuntimePairingService({
    repository,
    environments,
    manager,
    publish: () => undefined,
    publicUrl: () => options.publicUrl ?? PUBLIC_URL,
  });
  const service = createEnvironmentService(environments, manager, () => undefined);
  const { app, restore } = createAuthenticatedApiTestApp(
    TEST_USER,
    createEnvironmentEntityRoutes(service, pairing)
  );
  restoreAuth = restore;
  return { app, environments, repository, pairing };
}

async function seedWebSocketEnvironment(
  environments: ReturnType<typeof createEnvironmentRepository>,
  id = 'laptop'
): Promise<void> {
  await insertTestUser(TEST_USER);
  await environments.create({
    id,
    userId: TEST_USER.id,
    name: 'Laptop',
    transportKind: 'websocket',
    config: {},
    enabled: true,
  });
}

describe('runtime pairing routes', () => {
  it('issues a token once and reports only its metadata afterwards', async () => {
    const { app, environments, repository } = createTestApp();
    await seedWebSocketEnvironment(environments);

    const issued = await app.handle(
      new Request('http://localhost/environments/laptop/pairing', { method: 'POST' })
    );
    const issuedPayload = (await issued.json()) as RuntimePairingIssue;

    expect(issued.status).toBe(201);
    expect(issuedPayload.token).toStartWith('mrt_');
    expect(issuedPayload.environmentId).toBe('laptop');
    expect(issuedPayload.lastSeenAt).toBeNull();

    const stored = await repository.findActiveForEnvironment(TEST_USER.id, 'laptop');
    expect(stored?.tokenHash).not.toContain(issuedPayload.token);

    const status = await app.handle(new Request('http://localhost/environments/laptop/pairing'));
    const statusPayload = (await status.json()) as RuntimePairingStatus;

    expect(status.status).toBe(200);
    expect(statusPayload.endpoint).toBe('wss://hub.mangostudio.test/api/runtime');
    expect(statusPayload.token).toEqual({
      environmentId: 'laptop',
      createdAt: issuedPayload.createdAt,
      lastSeenAt: null,
    });
    expect(JSON.stringify(statusPayload)).not.toContain(issuedPayload.token);
  });

  it('reports no endpoint when the hub was never told how peers reach it', async () => {
    const { app, environments } = createTestApp({ publicUrl: '' });
    await seedWebSocketEnvironment(environments);

    const status = await app.handle(new Request('http://localhost/environments/laptop/pairing'));

    expect(((await status.json()) as RuntimePairingStatus).endpoint).toBeNull();
  });

  it('verifies the issued token and refuses every near miss', async () => {
    const { app, environments, pairing } = createTestApp();
    await seedWebSocketEnvironment(environments);

    const issued = (await (
      await app.handle(
        new Request('http://localhost/environments/laptop/pairing', { method: 'POST' })
      )
    ).json()) as RuntimePairingIssue;

    expect(await pairing.verify(issued.token)).toEqual({
      tokenId: expect.any(String),
      userId: TEST_USER.id,
      environmentId: 'laptop',
    });
    expect(await pairing.verify(`${issued.token}x`)).toBeNull();
    expect(await pairing.verify(issued.token.slice(0, -1))).toBeNull();
    expect(await pairing.verify('mrt_unknown.selector')).toBeNull();
    expect(await pairing.verify('')).toBeNull();
  });

  it('retires the previous token when a new one is issued', async () => {
    const { app, environments, pairing } = createTestApp();
    await seedWebSocketEnvironment(environments);

    const first = (await (
      await app.handle(
        new Request('http://localhost/environments/laptop/pairing', { method: 'POST' })
      )
    ).json()) as RuntimePairingIssue;
    const second = (await (
      await app.handle(
        new Request('http://localhost/environments/laptop/pairing', { method: 'POST' })
      )
    ).json()) as RuntimePairingIssue;

    expect(second.token).not.toBe(first.token);
    expect(await pairing.verify(first.token)).toBeNull();
    expect(await pairing.verify(second.token)).not.toBeNull();
  });

  it('refuses a revoked token and reports nothing left to revoke', async () => {
    const { app, environments, pairing } = createTestApp();
    await seedWebSocketEnvironment(environments);

    const issued = (await (
      await app.handle(
        new Request('http://localhost/environments/laptop/pairing', { method: 'POST' })
      )
    ).json()) as RuntimePairingIssue;

    const revoked = await app.handle(
      new Request('http://localhost/environments/laptop/pairing', { method: 'DELETE' })
    );
    expect(revoked.status).toBe(200);
    expect(await pairing.verify(issued.token)).toBeNull();

    const again = await app.handle(
      new Request('http://localhost/environments/laptop/pairing', { method: 'DELETE' })
    );
    expect(again.status).toBe(404);
  });

  it('drops the token with the environment row that authorized it', async () => {
    const { app, environments, pairing, repository } = createTestApp();
    await seedWebSocketEnvironment(environments);

    const issued = (await (
      await app.handle(
        new Request('http://localhost/environments/laptop/pairing', { method: 'POST' })
      )
    ).json()) as RuntimePairingIssue;

    expect(await environments.remove(TEST_USER.id, 'laptop')).toBe('removed');
    expect(await repository.findActiveForEnvironment(TEST_USER.id, 'laptop')).toBeNull();
    expect(await pairing.verify(issued.token)).toBeNull();
  });

  it('refuses pairing for transports the hub dials itself', async () => {
    const { app, environments } = createTestApp();
    await insertTestUser(TEST_USER);
    await environments.create({
      id: 'dev-box',
      userId: TEST_USER.id,
      name: 'Dev box',
      transportKind: 'stdio',
      config: {},
      enabled: true,
    });

    const issued = await app.handle(
      new Request('http://localhost/environments/dev-box/pairing', { method: 'POST' })
    );
    const missing = await app.handle(new Request('http://localhost/environments/ghost/pairing'));

    expect(issued.status).toBe(409);
    expect(missing.status).toBe(404);
  });
});
