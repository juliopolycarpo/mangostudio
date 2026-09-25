/**
 * The hub's Direct URL transport (`transportKind: 'http'`) against a runtime
 * listening on a real loopback socket.
 *
 * The token, rotation and refusal cases, and the plain request round-trip,
 * dial the compiled binary's own `serve`: they are about what that listener
 * accepts and refuses. The external-agent round-trip needs a scripted vendor
 * no real runtime can be handed from a test, so it dials a fake runtime host
 * behind a listener with the same door (bearer token, `mango.v1`).
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { realpath } from 'node:fs/promises';
import { RESERVED_ERROR_CODES, RemoteError } from '@mangostudio/protocol';
import { rejectionOf } from '@mangostudio/protocol/testing';
import {
  type ExternalAgentConfiguration,
  NO_EXTERNAL_AGENT_CAPABILITIES,
} from '@mangostudio/shared/external-agents';
import {
  RUNTIME_EXTERNAL_AGENT_TOPIC,
  type RuntimeCapabilityManifest,
} from '@mangostudio/shared/runtime-contract';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
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
import { serveFakeRuntimeOverWebSocket } from '../../support/fake-runtime-websocket-server';
import { InMemorySecretStore } from '../../support/mocks/mock-secret-store';
import {
  FakeRuntimeDefinition,
  fixedConsent,
  TEST_RUNTIME_MANIFEST,
} from '../../support/runtime-fixture';
import {
  resolveRustRuntimeBinary,
  rustRuntimeVersion,
  skipWithoutRustBinary,
} from '../../support/rust-runtime-binary';
import { startRustServe } from '../../support/rust-serve-runtime';

const binary = resolveRustRuntimeBinary();

const TEST_USER = {
  id: 'http-runtime-user',
  name: 'HTTP Runtime User',
  email: 'http-runtime@mangostudio.test',
};

const handles: Array<{ close(): void | Promise<void> }> = [];
let runtimeVersion: string;

beforeAll(async () => {
  if (!binary.available) return;
  runtimeVersion = await rustRuntimeVersion(binary.path);
});

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.close()));
  setRuntimeConnectionManagerForTests(undefined);
  setRuntimeTokenStoreForTests(undefined);
  await getDb().deleteFrom('environments').where('userId', '=', TEST_USER.id).execute();
  await getDb().deleteFrom('user').where('id', '=', TEST_USER.id).execute();
});

describe('Direct URL http runtime', () => {
  it.skipIf(skipWithoutRustBinary(binary, 'connect-http-runtime'))(
    'connects through the secret-store token and round-trips a request',
    async () => {
      await insertTestUser(TEST_USER);
      const store = new InMemorySecretStore();
      setRuntimeTokenStoreForTests(store);
      const token = 'integration-serve-token';
      const workspacePath = await realpath(process.cwd());
      const serve = await startRustServe(binary.path, { label: 'http-round-trip', token });
      handles.push(serve);

      const { manager, service } = httpEnvironments(store);

      const created = await service.create(TEST_USER.id, {
        id: 'lan-box',
        name: 'LAN box',
        transportKind: 'http',
        config: { baseUrl: serve.baseUrl },
        token,
      });
      expect(created.hasRuntimeToken).toBe(true);
      expect(created.config).toEqual({ baseUrl: serve.baseUrl });

      const connected = await service.connect(TEST_USER.id, 'lan-box');
      expect(connected.status.state).toBe('connected');
      expect(connected.status.runtimeVersion).toBe(runtimeVersion);

      const client = await manager.getClient(TEST_USER.id, 'lan-box');
      const result = await client.workspace.validate({ path: workspacePath });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('The runtime rejected its integration-test workspace.');
      expect(result.resolvedPath).toBe(workspacePath);

      // A listening runtime attests what it observes about its own process —
      // here the scratch credential home it runs under — over this transport
      // just as over stdio. Whether a hub may rely on it is the hub's call.
      expect(client.manifest.identityIsolation?.method).toMatch(/^(os-account|container)$/);
    },
    20_000
  );

  it('drives an external-agent session over the Direct URL transport', async () => {
    await insertTestUser(TEST_USER);
    const store = new InMemorySecretStore();
    setRuntimeTokenStoreForTests(store);
    const token = 'integration-fake-serve-token';
    const workspacePath = await realpath(process.cwd());
    const definition: FakeRuntimeDefinition = new FakeRuntimeDefinition({
      runtimeVersion: 'http-integration',
      manifest: EXTERNAL_AGENT_MANIFEST,
      consent: fixedConsent(RUNTIME_CONSENT_PRESETS.full, 'remote'),
      handlers: {
        'external-agent.discover': () => ({
          descriptors: [
            {
              targetId: 'codex',
              installed: true,
              authState: 'signed-in',
              capabilities: HTTP_FIXTURE_CAPABILITIES,
              supportedConfigurations: [],
            },
          ],
        }),
        'external-agent.open': (params: { configuration: ExternalAgentConfiguration }) => ({
          nativeSessionId: 'http-native-session',
          resumed: false,
          effectiveConfiguration: params.configuration,
          capabilities: HTTP_FIXTURE_CAPABILITIES,
        }),
        'external-agent.turn': (params: { sessionId: string }) => {
          // After the answer, as a runtime streams a turn it already acknowledged.
          setTimeout(() => {
            definition.emit({
              topic: RUNTIME_EXTERNAL_AGENT_TOPIC,
              payload: {
                sessionId: params.sessionId,
                nativeTurnId: 'http-native-turn',
                sequence: 1,
                emittedAtMs: Date.now(),
                event: { type: 'text_delta', text: 'remote fixture' },
              },
            });
          }, 0);
          return { nativeTurnId: 'http-native-turn' };
        },
      },
    });
    const serve = serveFakeRuntimeOverWebSocket(definition, { token });
    handles.push(serve);

    const { manager, service } = httpEnvironments(store);
    await service.create(TEST_USER.id, {
      id: 'lan-agent-box',
      name: 'LAN agent box',
      transportKind: 'http',
      config: { baseUrl: serve.baseUrl },
      token,
    });
    const connected = await service.connect(TEST_USER.id, 'lan-agent-box');
    expect(connected.status.state).toBe('connected');
    expect(connected.status.runtimeVersion).toBe('http-integration');

    const client = await manager.getClient(TEST_USER.id, 'lan-agent-box');
    expect(client.manifest.externalAgents).toEqual(['codex']);
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

  it.skipIf(skipWithoutRustBinary(binary, 'connect-http-runtime'))(
    'refuses the old token after rotation',
    async () => {
      await insertTestUser(TEST_USER);
      const store = new InMemorySecretStore();
      setRuntimeTokenStoreForTests(store);
      const firstToken = 'first-serve-token';
      const secondToken = 'second-serve-token';

      const serve = await startRustServe(binary.path, {
        label: 'http-rotation',
        token: secondToken,
      });
      handles.push(serve);

      const { service } = httpEnvironments(store);

      await service.create(TEST_USER.id, {
        id: 'rotate-box',
        name: 'Rotate box',
        transportKind: 'http',
        config: { baseUrl: serve.baseUrl },
        token: firstToken,
      });

      expect(await rejectionOf(service.connect(TEST_USER.id, 'rotate-box'))).toBeInstanceOf(Error);

      await service.update(TEST_USER.id, 'rotate-box', { token: secondToken });
      const connected = await service.connect(TEST_USER.id, 'rotate-box');
      expect(connected.status.state).toBe('connected');
    },
    20_000
  );

  it('reports a refused upgrade as UNAVAILABLE, keeping the transport sentence', async () => {
    await insertTestUser(TEST_USER);
    const store = new InMemorySecretStore();
    setRuntimeTokenStoreForTests(store);
    // A listener that refuses the upgrade itself (an empty 401), so the dial
    // never becomes a socket: the hub's own transport sentence is all there is.
    const serve = serveFakeRuntimeOverWebSocket(
      new FakeRuntimeDefinition({
        runtimeVersion: 'http-refusal',
        manifest: TEST_RUNTIME_MANIFEST,
        consent: fixedConsent(RUNTIME_CONSENT_PRESETS.full, 'remote'),
        handlers: {},
      }),
      { token: 'the-only-token' }
    );
    handles.push(serve);
    const baseUrl = serve.baseUrl;
    await persistRuntimeToken(TEST_USER.id, 'refused-box', 'wrong-token', store);

    const error = await rejectionOf(
      connectHttpRuntime(
        { id: 'refused-box', userId: TEST_USER.id, config: { baseUrl } },
        () => undefined
      )
    );

    expect(error).toBeInstanceOf(RemoteError);
    expect(error).toMatchObject({
      code: RESERVED_ERROR_CODES.UNAVAILABLE,
      message:
        `Environment "refused-box" could not open a runtime session at ${baseUrl}: ` +
        `WebSocket to ws://127.0.0.1:${serve.port}/ failed before it opened.`,
      details: { environmentId: 'refused-box', baseUrl },
    });
  }, 20_000);

  it.skipIf(skipWithoutRustBinary(binary, 'connect-http-runtime'))(
    'reports a credential serve refuses as UNAVAILABLE, naming its close code',
    async () => {
      await insertTestUser(TEST_USER);
      const store = new InMemorySecretStore();
      setRuntimeTokenStoreForTests(store);
      const serve = await startRustServe(binary.path, {
        label: 'http-refusal',
        token: 'the-only-token',
      });
      handles.push(serve);
      const baseUrl = serve.baseUrl;
      await persistRuntimeToken(TEST_USER.id, 'refused-box', 'wrong-token', store);

      const error = await rejectionOf(
        connectHttpRuntime(
          { id: 'refused-box', userId: TEST_USER.id, config: { baseUrl } },
          () => undefined
        )
      );

      // The binary completes the upgrade and closes it with 4401, so the hub
      // reports the close it saw rather than a dial that never opened.
      expect(error).toBeInstanceOf(RemoteError);
      expect(error).toMatchObject({
        code: RESERVED_ERROR_CODES.UNAVAILABLE,
        message: 'The session closed before the handshake completed (4401: credential refused).',
        details: { closeCode: 4401 },
      });
    },
    20_000
  );

  it('reports a credential refused after the upgrade as UNAVAILABLE, naming its close code', async () => {
    // The hub half of the case above, served by the fake host so the ordinary
    // lane covers the 4401 mapping where no Rust binary is built.
    await insertTestUser(TEST_USER);
    const store = new InMemorySecretStore();
    setRuntimeTokenStoreForTests(store);
    const serve = serveFakeRuntimeOverWebSocket(
      new FakeRuntimeDefinition({
        runtimeVersion: 'http-refusal',
        manifest: TEST_RUNTIME_MANIFEST,
        consent: fixedConsent(RUNTIME_CONSENT_PRESETS.full, 'remote'),
        handlers: {},
      }),
      { token: 'the-only-token', refuse: 'after-upgrade' }
    );
    handles.push(serve);
    await persistRuntimeToken(TEST_USER.id, 'refused-box', 'wrong-token', store);

    const error = await rejectionOf(
      connectHttpRuntime(
        { id: 'refused-box', userId: TEST_USER.id, config: { baseUrl: serve.baseUrl } },
        () => undefined
      )
    );

    expect(error).toBeInstanceOf(RemoteError);
    expect(error).toMatchObject({
      code: RESERVED_ERROR_CODES.UNAVAILABLE,
      message: 'The session closed before the handshake completed (4401: credential refused).',
      details: { closeCode: 4401 },
    });
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

/** The hub side of a Direct URL environment: a manager dialling `http`, and the service over it. */
function httpEnvironments(store: InMemorySecretStore) {
  const repository = createEnvironmentRepository(getDb());
  const manager = new RuntimeConnectionManager({
    resolveEnvironment: async (userId, environmentId) => repository.find(userId, environmentId),
    connectors: { http: connectHttpRuntime },
  });
  setRuntimeConnectionManagerForTests(manager);
  const service = createEnvironmentService(repository, manager, () => undefined, store);
  return { manager, service };
}

const HTTP_FIXTURE_CAPABILITIES = {
  ...NO_EXTERNAL_AGENT_CAPABILITIES,
  structuredStreaming: true,
};

/** A remote runtime offering one vendor, the way a runtime announces the targets it can drive. */
const EXTERNAL_AGENT_MANIFEST: RuntimeCapabilityManifest = {
  ...TEST_RUNTIME_MANIFEST,
  features: { ...TEST_RUNTIME_MANIFEST.features, externalAgents: true },
  externalAgents: ['codex'],
};
