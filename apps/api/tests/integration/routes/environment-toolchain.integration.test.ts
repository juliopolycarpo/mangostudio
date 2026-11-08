import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import {
  type AgentCliStatus,
  type Environment,
  LOCAL_ENVIRONMENT_ID,
  type RuntimeId,
  type RuntimeStatus,
  type ToolchainSelection,
  type VersionManagerId,
  type VersionManagerStatus,
} from '@mangostudio/shared/environments';
import type { LibraryLocationStatus, LibraryTargetId } from '@mangostudio/shared/library';
import { TableNode } from 'kysely';

import { getDb } from '../../../src/db/database';
import { createEnvironmentService } from '../../../src/modules/environments/application/environment-service';
import type {
  EnvironmentProbingService,
  ProbeOptions,
  ProbeScope,
} from '../../../src/modules/environments/application/probing-service';
import { createToolchainService } from '../../../src/modules/environments/application/toolchain-service';
import { createEnvironmentEntityRoutes } from '../../../src/modules/environments/http/environment-entity-routes';
import {
  type CreateEnvironmentRecord,
  createEnvironmentRepository,
} from '../../../src/modules/environments/infrastructure/environment-repository';
import { createEnvironmentToolchainRepository } from '../../../src/modules/environments/infrastructure/environment-toolchain-repository';
import { RuntimeConnectionManager } from '../../../src/services/runtime-client/runtime-connection-manager';
import type { SecretStore } from '../../../src/services/secret-store/store';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'environment-toolchain-user',
  name: 'Environment Toolchain User',
  email: 'environment-toolchain@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await getDb().deleteFrom('environments').where('userId', '=', TEST_USER.id).execute();
  await getDb().deleteFrom('environment_toolchains').where('userId', '=', TEST_USER.id).execute();
  await getDb().deleteFrom('user').where('id', '=', TEST_USER.id).execute();
});

/** Answers `getRuntimeStatus` with a configurable installation list; every other member throws. */
class FakeEnvironmentProbingService implements EnvironmentProbingService {
  constructor(
    private readonly installedPaths: Partial<Record<RuntimeId, readonly string[]>>,
    private readonly beforeStatus?: () => Promise<void>
  ) {}

  async getRuntimeStatus(
    _scope: ProbeScope,
    id: RuntimeId,
    _options?: ProbeOptions
  ): Promise<RuntimeStatus | null> {
    await this.beforeStatus?.();
    const paths = this.installedPaths[id];
    if (!paths) return null;
    return {
      id,
      health: 'ok',
      installations: paths.map((path) => ({
        path,
        rawPath: path,
        version: null,
        origin: 'path',
        effective: true,
      })),
      findings: [],
      installable: true,
      probedAtMs: 1_700_000_000_000,
    };
  }

  listRuntimeStatuses(): Promise<RuntimeStatus[]> {
    throw new Error('not implemented');
  }
  listVersionManagerStatuses(): Promise<VersionManagerStatus[]> {
    throw new Error('not implemented');
  }
  getVersionManagerStatus(
    _scope: ProbeScope,
    _id: VersionManagerId
  ): Promise<VersionManagerStatus | null> {
    throw new Error('not implemented');
  }
  listAgentCliStatuses(): Promise<AgentCliStatus[]> {
    throw new Error('not implemented');
  }
  getAgentCliStatus(
    _scope: ProbeScope,
    _targetId: LibraryTargetId
  ): Promise<AgentCliStatus | null> {
    throw new Error('not implemented');
  }
  listLocationStatuses(): Promise<LibraryLocationStatus[]> {
    throw new Error('not implemented');
  }
  resetCache(): void {
    // No cache in this fake; nothing to drop.
  }
  resetLocationCache(): void {
    // No cache in this fake; nothing to drop.
  }
}

class HeldTokenStore implements SecretStore {
  readonly writing = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  getSecret(): Promise<string | null> {
    return Promise.resolve(null);
  }

  async setSecret(): Promise<void> {
    this.writing.resolve();
    await this.release.promise;
  }

  deleteSecret(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

function createTestApp(
  installedPaths: Partial<Record<RuntimeId, readonly string[]>> = {},
  toolchainReads: string[] = [],
  beforeStatus?: () => Promise<void>,
  secretStore?: SecretStore
) {
  const toolchainDb = getDb().withPlugin({
    transformQuery({ node }) {
      if (
        node.kind === 'SelectQueryNode' &&
        node.from?.froms.some(
          (from) => TableNode.is(from) && from.table.identifier.name === 'environment_toolchains'
        )
      ) {
        toolchainReads.push(JSON.stringify(node));
      }
      return node;
    },
    transformResult({ result }) {
      return Promise.resolve(result);
    },
  });
  const repository = createEnvironmentRepository(getDb());
  const manager = new RuntimeConnectionManager({
    resolveEnvironment: async (userId, environmentId) => repository.find(userId, environmentId),
    connectors: {},
  });
  const toolchainRepository = createEnvironmentToolchainRepository(toolchainDb);
  const toolchain = createToolchainService(
    toolchainRepository,
    new FakeEnvironmentProbingService(installedPaths, beforeStatus)
  );
  const service = createEnvironmentService(
    repository,
    manager,
    undefined,
    secretStore,
    {
      hasActiveInstall: () => false,
      cancelActiveRun: () => false,
      // eslint-disable-next-line @typescript-eslint/require-await -- The test double preserves its Promise-returning interface contract.
      removeRuntimeBytes: async () => undefined,
    },
    toolchain
  );
  const { app, restore } = createAuthenticatedApiTestApp(
    TEST_USER,
    createEnvironmentEntityRoutes(service, undefined, undefined, toolchain)
  );
  restoreAuth = restore;
  return { app, repository, service, manager, toolchainRepository };
}

function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

describe('environment toolchain route', () => {
  it('reads the toolchain once for a list of eight environments, including Local and defaults', async () => {
    const reads: string[] = [];
    const { app, repository } = createTestApp({}, reads);
    const selections = createEnvironmentToolchainRepository();
    for (let index = 0; index < 8; index += 1) {
      await repository.create({
        id: `box-${index}`,
        userId: TEST_USER.id,
        name: `Box ${index}`,
        transportKind: 'stdio',
        config: {},
        enabled: true,
      });
    }
    await selections.upsert(TEST_USER.id, 'local', { bun: '/local/bun' }, 1);
    await selections.upsert(TEST_USER.id, 'box-0', { node: '/remote/node' }, 1);
    // The same IDs belong to two users. Neither selection may leak.
    const otherUser = `${TEST_USER.id}-other`;
    try {
      await selections.upsert(otherUser, 'local', { bun: '/other/bun' }, 1);
      await repository.create({
        id: 'box-1',
        userId: otherUser,
        name: 'Other box',
        transportKind: 'stdio',
        config: {},
        enabled: true,
      });
      await selections.upsert(otherUser, 'box-1', { node: '/other/node' }, 1);
      const response = await app.handle(new Request('http://localhost/environments'));
      expect(response.status).toBe(200);
      const environments = (await response.json()) as Environment[];
      expect(environments).toHaveLength(9);
      expect(environments[0]?.id).toBe(LOCAL_ENVIRONMENT_ID);
      expect(environments[0]?.toolchain).toEqual({ node: 'auto', bun: '/local/bun' });
      expect(environments.find(({ id }) => id === 'box-0')?.toolchain).toEqual({
        node: '/remote/node',
        bun: 'auto',
      });
      for (const environment of environments.filter(({ id }) => id !== 'local' && id !== 'box-0')) {
        expect(environment.toolchain).toEqual({ node: 'auto', bun: 'auto' });
      }
      expect(reads).toHaveLength(1);
    } finally {
      await getDb().deleteFrom('environment_toolchains').where('userId', '=', otherUser).execute();
      await getDb().deleteFrom('environments').where('userId', '=', otherUser).execute();
    }
  });

  it('returns default Local for a user with no saved environments or selections', async () => {
    const reads: string[] = [];
    const { app } = createTestApp({}, reads);
    const response = await app.handle(new Request('http://localhost/environments'));
    expect(response.status).toBe(200);
    const environments = (await response.json()) as Environment[];
    expect(environments).toHaveLength(1);
    expect(environments[0]?.id).toBe(LOCAL_ENVIRONMENT_ID);
    expect(environments[0]?.toolchain).toEqual({ node: 'auto', bun: 'auto' });
    expect(reads).toHaveLength(1);
  });

  it('keeps single-environment reads for create, find, update, connect and disconnect', async () => {
    const reads: string[] = [];
    const { service, manager } = createTestApp({}, reads);
    await service.create(TEST_USER.id, {
      id: 'single-box',
      name: 'Single box',
      transportKind: 'stdio',
      config: {},
    });
    await service.find(TEST_USER.id, 'single-box');
    await service.update(TEST_USER.id, 'single-box', { name: 'Renamed' });
    // Only connection I/O is stubbed; shaping the response still uses the real service and DB.
    const connect = spyOn(manager, 'connectInteractive').mockResolvedValue('connected');
    try {
      await service.connect(TEST_USER.id, 'single-box');
    } finally {
      connect.mockRestore();
    }
    await service.disconnect(TEST_USER.id, 'single-box');
    expect(reads).toHaveLength(5);
    for (const query of reads) {
      expect(query).toContain('environmentId');
      expect(query).toContain('single-box');
    }
  });

  it('rejects an auto selection for an unknown environment without persisting a row', async () => {
    const { app } = createTestApp();
    const response = await app.handle(
      new Request(
        'http://localhost/environments/unknown-box/toolchain',
        jsonRequest('PUT', { node: 'auto' })
      )
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: 'Environment "unknown-box" was not found.',
    });
    expect(
      await createEnvironmentToolchainRepository().get(TEST_USER.id, 'unknown-box')
    ).toBeNull();
  });

  it('rejects a pinned selection if the environment is deleted during the probe', async () => {
    const probeStarted = Promise.withResolvers<void>();
    const releaseProbe = Promise.withResolvers<void>();
    const { app, repository } = createTestApp({ node: ['/opt/node/bin/node'] }, [], () => {
      probeStarted.resolve();
      return releaseProbe.promise;
    });
    await repository.create({
      id: 'deleted-box',
      userId: TEST_USER.id,
      name: 'Deleted box',
      transportKind: 'stdio',
      config: {},
      enabled: true,
    });
    const update = app.handle(
      new Request(
        'http://localhost/environments/deleted-box/toolchain',
        jsonRequest('PUT', { node: '/opt/node/bin/node' })
      )
    );
    try {
      await probeStarted.promise;
      const removal = await app.handle(
        new Request('http://localhost/environments/deleted-box', { method: 'DELETE' })
      );
      expect(removal.status).toBe(200);
    } finally {
      releaseProbe.resolve();
    }
    expect((await update).status).toBe(404);
    expect(
      await createEnvironmentToolchainRepository().get(TEST_USER.id, 'deleted-box')
    ).toBeNull();
  });

  it.each(['recreated', 'reconfigured'] as const)(
    'rejects a pinned selection if the environment is %s during the probe',
    async (change) => {
      const probeStarted = Promise.withResolvers<void>();
      const releaseProbe = Promise.withResolvers<void>();
      const { app, repository } = createTestApp({ node: ['/opt/node/bin/node'] }, [], () => {
        probeStarted.resolve();
        return releaseProbe.promise;
      });
      const input = {
        id: 'changed-box',
        userId: TEST_USER.id,
        name: 'Changed box',
        transportKind: 'stdio' as const,
        config: {},
        enabled: true,
      };
      await repository.create(input);
      const update = app.handle(
        new Request(
          'http://localhost/environments/changed-box/toolchain',
          jsonRequest('PUT', { node: '/opt/node/bin/node' })
        )
      );
      try {
        await probeStarted.promise;
        if (change === 'recreated') {
          const removal = await app.handle(
            new Request('http://localhost/environments/changed-box', { method: 'DELETE' })
          );
          expect(removal.status).toBe(200);
          expect(await repository.create(input)).not.toBeNull();
        } else {
          expect(
            await repository.update(TEST_USER.id, input.id, { config: { binaryPath: '/other' } })
          ).not.toBeNull();
        }
      } finally {
        releaseProbe.resolve();
      }
      const response = await update;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: 'Environment "changed-box" changed while its toolchain path was being verified.',
      });
      expect(await createEnvironmentToolchainRepository().get(TEST_USER.id, input.id)).toBeNull();
    }
  );

  it('blocks a pin while a repoint is saving its token and the old probe is still available', async () => {
    const store = new HeldTokenStore();
    const { app, repository } = createTestApp({ node: ['/old/node'] }, [], undefined, store);
    const id = 'direct-box';
    await repository.create({
      id,
      userId: TEST_USER.id,
      name: 'Direct box',
      transportKind: 'http',
      config: { baseUrl: 'http://old.example' },
      enabled: true,
    });
    const edit = app.handle(
      new Request(
        `http://localhost/environments/${id}`,
        jsonRequest('PUT', { config: { baseUrl: 'http://new.example' }, token: 'test-token' })
      )
    );
    try {
      await store.writing.promise;
      expect((await repository.find(TEST_USER.id, id))?.config).toEqual({
        baseUrl: 'http://new.example',
      });
      const response = await app.handle(
        new Request(
          `http://localhost/environments/${id}/toolchain`,
          jsonRequest('PUT', { node: '/old/node' })
        )
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: 'Environment "direct-box" is being reconfigured.',
      });
      const selections = createEnvironmentToolchainRepository();
      expect(await selections.get(TEST_USER.id, id)).toBeNull();
      const reset = await app.handle(
        new Request(
          `http://localhost/environments/${id}/toolchain`,
          jsonRequest('PUT', { node: 'auto' })
        )
      );
      expect(reset.status).toBe(200);
      expect(await reset.json()).toEqual({ node: 'auto', bun: 'auto' });
    } finally {
      store.release.resolve();
      expect((await edit).status).toBe(200);
    }
  });

  it('blocks a pin whose revision read resumes after an edit writes the new definition', async () => {
    const store = new HeldTokenStore();
    const { app, repository, toolchainRepository } = createTestApp(
      { node: ['/old/node'] },
      [],
      undefined,
      store
    );
    const id = 'waiting-box';
    await repository.create({
      id,
      userId: TEST_USER.id,
      name: 'Waiting box',
      transportKind: 'http',
      config: { baseUrl: 'http://old.example' },
      enabled: true,
    });
    const reading = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    const getRevision = toolchainRepository.getRevision.bind(toolchainRepository);
    const pausedRead = spyOn(toolchainRepository, 'getRevision').mockImplementationOnce(
      async (userId, environmentId) => {
        reading.resolve();
        await releaseRead.promise;
        return await getRevision(userId, environmentId);
      }
    );

    const pin = app.handle(
      new Request(
        `http://localhost/environments/${id}/toolchain`,
        jsonRequest('PUT', { node: '/old/node' })
      )
    );
    let edit: Promise<Response> | undefined;
    try {
      await reading.promise;
      edit = app.handle(
        new Request(
          `http://localhost/environments/${id}`,
          jsonRequest('PUT', { config: { baseUrl: 'http://new.example' }, token: 'test-token' })
        )
      );
      await store.writing.promise;
      releaseRead.resolve();
      const response = await pin;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: 'Environment "waiting-box" is being reconfigured.',
      });
      expect(await toolchainRepository.get(TEST_USER.id, id)).toBeNull();
    } finally {
      releaseRead.resolve();
      store.release.resolve();
      pausedRead.mockRestore();
      if (edit) expect((await edit).status).toBe(200);
    }
  });

  it('accepts a probed path and the environments list reflects it', async () => {
    const { app, repository } = createTestApp({ node: ['/opt/node/bin/node'] });
    const other: CreateEnvironmentRecord = {
      id: 'dev-box',
      userId: TEST_USER.id,
      name: 'Dev box',
      transportKind: 'stdio',
      config: {},
      enabled: true,
    };
    await repository.create(other);

    const response = await app.handle(
      new Request(
        'http://localhost/environments/dev-box/toolchain',
        jsonRequest('PUT', { node: '/opt/node/bin/node' })
      )
    );
    const payload = (await response.json()) as ToolchainSelection;

    expect(response.status).toBe(200);
    expect(payload).toEqual({ node: '/opt/node/bin/node', bun: 'auto' });

    const listResponse = await app.handle(new Request('http://localhost/environments'));
    const listPayload = (await listResponse.json()) as Environment[];
    const devBox = listPayload.find((environment) => environment.id === 'dev-box');
    expect(devBox?.toolchain).toEqual({ node: '/opt/node/bin/node', bun: 'auto' });
  });

  it('rejects an unknown path with 422 and both the expected and received value', async () => {
    const { app, repository } = createTestApp({ node: ['/opt/node/bin/node'] });
    await repository.create({
      id: 'dev-box',
      userId: TEST_USER.id,
      name: 'Dev box',
      transportKind: 'stdio',
      config: {},
      enabled: true,
    });

    const response = await app.handle(
      new Request(
        'http://localhost/environments/dev-box/toolchain',
        jsonRequest('PUT', { node: '/tmp/evil' })
      )
    );
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(422);
    expect(payload.error).toContain('expected one of: /opt/node/bin/node');
    expect(payload.error).toContain('received: /tmp/evil');
  });

  it('accepts a selection for the local environment', async () => {
    const { app } = createTestApp({ bun: ['/opt/bun/bin/bun'] });

    const response = await app.handle(
      new Request(
        `http://localhost/environments/${LOCAL_ENVIRONMENT_ID}/toolchain`,
        jsonRequest('PUT', { bun: '/opt/bun/bin/bun' })
      )
    );
    const payload = (await response.json()) as ToolchainSelection;

    expect(response.status).toBe(200);
    expect(payload).toEqual({ node: 'auto', bun: '/opt/bun/bin/bun' });

    const listResponse = await app.handle(new Request('http://localhost/environments'));
    const listPayload = (await listResponse.json()) as Environment[];
    const local = listPayload.find((environment) => environment.id === LOCAL_ENVIRONMENT_ID);
    expect(local?.toolchain).toEqual({ node: 'auto', bun: '/opt/bun/bin/bun' });
  });

  it('deleting an environment removes its toolchain row', async () => {
    const { app, repository } = createTestApp({ node: ['/opt/node/bin/node'] });
    await repository.create({
      id: 'dev-box',
      userId: TEST_USER.id,
      name: 'Dev box',
      transportKind: 'stdio',
      config: {},
      enabled: true,
    });
    await app.handle(
      new Request(
        'http://localhost/environments/dev-box/toolchain',
        jsonRequest('PUT', { node: '/opt/node/bin/node' })
      )
    );

    const deleteResponse = await app.handle(
      new Request('http://localhost/environments/dev-box', { method: 'DELETE' })
    );
    expect(deleteResponse.status).toBe(200);

    // Re-creating the same id must not resurrect the previous choice: the row
    // is gone, not merely orphaned.
    await repository.create({
      id: 'dev-box',
      userId: TEST_USER.id,
      name: 'Dev box',
      transportKind: 'stdio',
      config: {},
      enabled: true,
    });
    const listResponse = await app.handle(new Request('http://localhost/environments'));
    const listPayload = (await listResponse.json()) as Environment[];
    const devBox = listPayload.find((environment) => environment.id === 'dev-box');
    expect(devBox?.toolchain).toEqual({ node: 'auto', bun: 'auto' });
  });
});
