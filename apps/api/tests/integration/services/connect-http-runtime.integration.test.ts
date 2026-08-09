import { afterEach, describe, expect, it } from 'bun:test';
import { realpath } from 'node:fs/promises';
import {
  createLocalRuntimeHost,
  type ExternalAgentAdapter,
  type ExternalAgentTurnStream,
  serveRuntime,
} from '@mangostudio/runtime';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
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

const handles: Array<{ close(): void | Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.close()));
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
    const adapter = new HttpFixtureExternalAgentAdapter();
    const workspacePath = await realpath(process.cwd());
    const serve = serveRuntime({
      listen: { hostname: '127.0.0.1', port: 0 },
      token,
      createHost: () =>
        createLocalRuntimeHost({
          runtimeVersion: 'http-integration',
          externalAgents: {
            adapters: [adapter],
            authorizeWorkspace: (path) => path === workspacePath,
            resolveExecutable: async () => ({ path: process.execPath }),
          },
        }),
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
    const result = await client.workspace.validate({ path: workspacePath });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('The runtime rejected its integration-test workspace.');
    expect(result.resolvedPath).toBe(workspacePath);

    // This is a real WebSocket transport boundary, but HTTP has no identity
    // attestation yet. The protocol remains driveable while product discovery
    // correctly keeps this environment unavailable until that proof exists.
    expect(client.manifest.externalAgents).toEqual(['codex']);
    expect(client.manifest.identityIsolation).toBeUndefined();
    await expect(
      client.externalAgents.discover({ targetIds: ['codex'], timeoutMs: 1_000 })
    ).resolves.toMatchObject({ descriptors: [{ targetId: 'codex', installed: true }] });
    await client.externalAgents.open({
      sessionId: 'http-session',
      targetId: 'codex',
      workspacePath,
      configuration: { level: 'default', routing: 'user', workspaceRoots: [] },
      resumeMode: 'fallback',
      timeoutMs: 1_000,
    });
    const event = Promise.withResolvers<string>();
    const unsubscribe = client.externalAgents.onEvent('http-session', (envelope) => {
      if (envelope.event.type === 'text_delta') event.resolve(envelope.event.text);
    });
    await client.externalAgents.turn({
      sessionId: 'http-session',
      clientMessageId: 'http-message',
      input: 'hello over http',
      configuration: { level: 'default', routing: 'user', workspaceRoots: [] },
    });
    expect(await event.promise).toBe('remote fixture');
    unsubscribe();
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

const HTTP_FIXTURE_CAPABILITIES = {
  ...NO_EXTERNAL_AGENT_CAPABILITIES,
  structuredStreaming: true,
};

class HttpFixtureExternalAgentAdapter implements ExternalAgentAdapter {
  readonly targetId = 'codex' as const;

  discover() {
    return Promise.resolve({
      targetId: this.targetId,
      installed: true,
      authState: 'signed-in' as const,
      capabilities: HTTP_FIXTURE_CAPABILITIES,
      supportedConfigurations: [],
    });
  }

  openSession(input: Parameters<ExternalAgentAdapter['openSession']>[0]) {
    return Promise.resolve({
      nativeSessionId: 'http-native-session',
      resumed: false,
      effectiveConfiguration: input.params.configuration,
      capabilities: HTTP_FIXTURE_CAPABILITIES,
    });
  }

  startTurn(): ExternalAgentTurnStream {
    return {
      nativeTurnId: 'http-native-turn',
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield { type: 'text_delta' as const, text: 'remote fixture' };
        yield { type: 'completed' as const };
      },
    };
  }

  respond() {
    return Promise.resolve();
  }

  cancel() {
    return Promise.resolve();
  }

  close() {
    return Promise.resolve();
  }
}
