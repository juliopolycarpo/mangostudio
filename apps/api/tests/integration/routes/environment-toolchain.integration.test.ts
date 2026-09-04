import { afterEach, describe, expect, it } from 'bun:test';
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
  constructor(private readonly installedPaths: Partial<Record<RuntimeId, readonly string[]>>) {}

  getRuntimeStatus(
    _scope: ProbeScope,
    id: RuntimeId,
    _options?: ProbeOptions
  ): Promise<RuntimeStatus | null> {
    const paths = this.installedPaths[id];
    if (!paths) return Promise.resolve(null);
    return Promise.resolve({
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
    });
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

function createTestApp(installedPaths: Partial<Record<RuntimeId, readonly string[]>> = {}) {
  const repository = createEnvironmentRepository(getDb());
  const manager = new RuntimeConnectionManager({
    resolveEnvironment: async (userId, environmentId) => repository.find(userId, environmentId),
    connectors: {},
  });
  const toolchain = createToolchainService(
    createEnvironmentToolchainRepository(getDb()),
    new FakeEnvironmentProbingService(installedPaths)
  );
  const service = createEnvironmentService(
    repository,
    manager,
    undefined,
    undefined,
    {
      hasActiveInstall: () => false,
      cancelActiveRun: () => false,
      removeRuntimeBytes: async () => undefined,
    },
    toolchain
  );
  const { app, restore } = createAuthenticatedApiTestApp(
    TEST_USER,
    createEnvironmentEntityRoutes(service, undefined, undefined, toolchain)
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

describe('environment toolchain route', () => {
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
