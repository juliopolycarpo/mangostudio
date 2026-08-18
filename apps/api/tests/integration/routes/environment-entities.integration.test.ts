import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectInProcessRuntime,
  createLocalRuntimeHost,
  createLocalRuntimeManifest,
  createRuntimeMethodHandlers,
  RuntimeHost,
} from '@mangostudio/runtime';
import type {
  CreateEnvironmentBody,
  Environment,
  RuntimeLifecycleView,
  UpdateEnvironmentBody,
} from '@mangostudio/shared/environments';
import { RuntimeLifecycleViewSchema } from '@mangostudio/shared/environments';
import type { RuntimeHealthReport, RuntimePlatformId } from '@mangostudio/shared/runtime-home';
import Value from 'typebox/value';
import { getDb } from '../../../src/db/database';
import { getVersion } from '../../../src/lib/config';
import {
  createEnvironmentService,
  type EnvironmentRuntimeEffects,
} from '../../../src/modules/environments/application/environment-service';
import {
  createRuntimeLifecycleService,
  type RuntimeLifecycleService,
} from '../../../src/modules/environments/application/runtime-lifecycle-service';
import { createEnvironmentEntityRoutes } from '../../../src/modules/environments/http/environment-entity-routes';
import {
  type CreateEnvironmentRecord,
  createEnvironmentRepository,
  type UpdateEnvironmentRecord,
} from '../../../src/modules/environments/infrastructure/environment-repository';
import { createLibraryBackupIndex } from '../../../src/modules/library/infrastructure/backup-index-repository';
import {
  createRealtimeBus,
  setRealtimeBusForTests,
} from '../../../src/services/realtime/realtime-bus';
import { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
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
const tempHomes: string[] = [];

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await getDb().deleteFrom('chats').where('userId', '=', TEST_USER.id).execute();
  await getDb().deleteFrom('library_backups').where('userId', '=', TEST_USER.id).execute();
  await getDb().deleteFrom('environments').where('userId', '=', TEST_USER.id).execute();
  await getDb().deleteFrom('user').where('id', '=', TEST_USER.id).execute();
  setRealtimeBusForTests(undefined);
  await Promise.all(tempHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function createTestApp(
  connectors: RuntimeConnectionManagerOptions['connectors'] = {},
  lifecycle?: RuntimeLifecycleService,
  runtimeEffects?: Partial<EnvironmentRuntimeEffects>,
  lifecycleFactory?: (manager: RuntimeConnectionManager) => RuntimeLifecycleService
) {
  const repository = createEnvironmentRepository(getDb());
  const manager = new RuntimeConnectionManager({
    resolveEnvironment: async (userId, environmentId) => {
      const row = await repository.find(userId, environmentId);
      return row;
    },
    connectors,
  });
  // Byte removal writes to another machine, so the default wiring is never what
  // a test should reach: overriding it is how the removal matrix gets covered
  // without owning a WSL distribution.
  const service = createEnvironmentService(repository, manager, undefined, undefined, {
    hasActiveInstall: () => false,
    cancelActiveRun: () => false,
    removeRuntimeBytes: async () => undefined,
    ...runtimeEffects,
  });
  const { app, restore } = createAuthenticatedApiTestApp(
    TEST_USER,
    createEnvironmentEntityRoutes(
      service,
      undefined,
      lifecycle ??
        lifecycleFactory?.(manager) ??
        createRuntimeLifecycleService({
          manager,
          provisioner: {
            ensure: async () => undefined,
            removeSlotBytes: async () => undefined,
            slotBytes: async () => null,
          },
        })
    )
  );
  restoreAuth = restore;
  return { app, repository, manager };
}

/** A real update-capable host whose health matches installed release bytes. */
function createProvisionedRuntimeHost(
  options: Parameters<typeof createLocalRuntimeHost>[0],
  platformId?: RuntimePlatformId,
  // Simulates a peer whose runtime predates the `platformId` field: `platform`
  // and `arch` still arrive, but nothing names the exact release identity.
  stripPlatformId = false
): RuntimeHost {
  let host: RuntimeHost | undefined;
  const registry = createRuntimeMethodHandlers({
    runtimeVersion: options.runtimeVersion,
    emit: (event) => host?.emit(event),
    ...(options.slot ? { slot: options.slot } : {}),
    ...(options.update ? { update: options.update } : {}),
  });
  const health = registry.handlers.get('runtime.health');
  if (!health) throw new Error('runtime.health handler is missing');
  const handlers = new Map(registry.handlers);
  handlers.set('runtime.health', async (params, context) => {
    const report = (await health(params, context)) as RuntimeHealthReport;
    const { platformId: _omitted, ...withoutPlatformId } = report;
    return {
      ...(stripPlatformId ? withoutPlatformId : report),
      source: 'provisioned',
      ...(platformId ? { platformId } : {}),
    } satisfies RuntimeHealthReport;
  });
  host = new RuntimeHost({
    runtimeVersion: options.runtimeVersion,
    manifest: createLocalRuntimeManifest(options.allow),
    handlers,
    isUpdateActive: registry.updateActive,
    onClose: () => void registry.close(),
    ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
  });
  return host;
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
        allowInstalls: true,
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

  /*
    Chats and MCP servers block a delete because they address the machine and
    would be left pointing at nothing. The library backup index is a listing
    cache, not a reference: it goes with the environment, or the backups page
    keeps a machine nobody can ever connect again.
  */
  it('drops the library backup index rows of a machine it removes', async () => {
    const { app } = createTestApp();
    await app.handle(
      new Request(
        'http://localhost/environments',
        jsonRequest('POST', {
          id: 'cache-box',
          name: 'Cache box',
          transportKind: 'stdio',
          config: { binaryPath: '/opt/mango-runtime' },
        } satisfies CreateEnvironmentBody)
      )
    );
    await createLibraryBackupIndex().record(TEST_USER.id, [
      {
        environmentId: 'cache-box',
        backupId: '2026-08-05T10-00-00.000Z-abcdef',
        createdAtMs: 1,
        sizeBytes: 10,
        pinned: false,
        operation: 'propagation',
      },
    ]);

    const removed = await app.handle(
      new Request('http://localhost/environments/cache-box', jsonRequest('DELETE'))
    );

    expect(removed.status).toBe(200);
    expect(await createLibraryBackupIndex().list(TEST_USER.id)).toEqual([]);
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
      error: 'Environment "active-box" is still used by one or more chats or MCP servers.',
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

  // #792: a cold pull is bounded at half an hour. The request has to come back
  // long before that, saying what it left running.
  it('answers a connect that started an image pull without waiting for it', async () => {
    let cancelled: AbortSignal | undefined;
    const { app, repository, manager } = createTestApp({
      container: (_definition, _onUnavailable, context) => {
        context.report('pulling');
        cancelled = context.signal;
        // Never settles: the pull is still running when the route answers.
        return new Promise<never>(() => undefined);
      },
    });
    await repository.create({
      id: 'cold-image',
      userId: TEST_USER.id,
      name: 'Cold image',
      transportKind: 'container',
      config: { image: 'node:22' },
      enabled: true,
    });

    const response = await app.handle(
      new Request('http://localhost/environments/cold-image/connect', jsonRequest('POST'))
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as Environment).toMatchObject({
      status: { state: 'connecting', pullingImage: true },
    });
    expect(manager.getStatus(TEST_USER.id, 'cold-image').pullingImage).toBe(true);

    // And the download is owned rather than abandoned: disconnecting stops it.
    await app.handle(
      new Request('http://localhost/environments/cold-image/disconnect', jsonRequest('POST'))
    );
    expect(cancelled?.aborted).toBe(true);
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

  it('returns a runtime lifecycle view for Local and WSL', async () => {
    const { app, repository } = createTestApp();
    await repository.create({
      id: 'wsl-box',
      userId: TEST_USER.id,
      name: 'WSL box',
      transportKind: 'wsl',
      config: { distro: 'Ubuntu' },
      enabled: true,
    });

    const local = await app.handle(new Request('http://localhost/environments/local/runtime'));
    expect(local.status).toBe(200);
    const localView = (await local.json()) as RuntimeLifecycleView;
    expect(Value.Check(RuntimeLifecycleViewSchema, localView)).toBe(true);
    expect(localView.actions).toEqual([]);

    const wsl = await app.handle(new Request('http://localhost/environments/wsl-box/runtime'));
    expect(wsl.status).toBe(200);
    const wslView = (await wsl.json()) as RuntimeLifecycleView;
    expect(Value.Check(RuntimeLifecycleViewSchema, wslView)).toBe(true);
    // Never connected, so no platform has been reported yet: `download` would
    // reject the click with "connect it once" the instant somebody pressed
    // it, so the action list withholds it until there is an identity to stage.
    expect(wslView.actions).toEqual(['install', 'reinstall', 'upgrade']);
    expect(wslView.stagedRuntime).toBeUndefined();
  });

  // `linux-x64` glibc and `linux-x64-musl` are different release assets. A
  // peer that predates `platformId` (or whose probe could not resolve one)
  // reports `platform`/`arch` alone, and those two fields cannot tell musl
  // from glibc — guessing glibc here would stage (and describe as "the
  // matching runtime") a binary that will not run on an actually-musl machine.
  it('withholds staging for a connected Linux peer with no exact platform identity', async () => {
    const originalVersion = process.env.VERSION;
    process.env.VERSION = '9.9.9-test';
    try {
      const host = createProvisionedRuntimeHost(
        { runtimeVersion: '0.0.1-old', slot: 'wsl' },
        undefined,
        true
      );
      const { app, repository, manager } = createTestApp({
        wsl: async (_definition, onUnavailable) => {
          const connection = await connectInProcessRuntime(host, { hubVersion: 'dev' });
          return {
            client: new RuntimeClient(connection.client, onUnavailable),
            close: () => connection.close(),
          };
        },
      });
      await repository.create({
        id: 'wsl-no-platform-id',
        userId: TEST_USER.id,
        name: 'WSL no platform id',
        transportKind: 'wsl',
        config: { distro: 'Ubuntu' },
        enabled: true,
      });
      await manager.connect(TEST_USER.id, 'wsl-no-platform-id');
      await manager.refreshManifest(TEST_USER.id, 'wsl-no-platform-id');

      const response = await app.handle(
        new Request('http://localhost/environments/wsl-no-platform-id/runtime')
      );
      expect(response.status).toBe(200);
      const view = (await response.json()) as RuntimeLifecycleView;
      expect(view.health?.platformId).toBeUndefined();
      expect(view.health?.platform).toBe('linux');
      expect(view.actions).not.toContain('download');
      expect(view.stagedRuntime).toBeUndefined();
      await manager.closeAll();
    } finally {
      if (originalVersion === undefined) delete process.env.VERSION;
      else process.env.VERSION = originalVersion;
    }
  });

  it('starts a WSL runtime install and streams SSE exit', async () => {
    let ensured = false;
    const { app, repository } = createTestApp(
      {},
      createRuntimeLifecycleService({
        provisioner: {
          ensure: async () => {
            ensured = true;
            await Promise.resolve();
          },
          removeSlotBytes: async () => undefined,
          slotBytes: async () => null,
        },
      })
    );
    await repository.create({
      id: 'wsl-install',
      userId: TEST_USER.id,
      name: 'WSL install',
      transportKind: 'wsl',
      config: { distro: 'Ubuntu' },
      enabled: true,
    });

    const started = await app.handle(
      new Request(
        'http://localhost/environments/wsl-install/runtime/install',
        jsonRequest('POST', { action: 'install' })
      )
    );
    expect(started.status).toBe(200);
    const { runId } = (await started.json()) as { runId: string };
    expect(runId.length).toBeGreaterThan(0);

    const log = await app.handle(
      new Request(`http://localhost/environments/wsl-install/runtime/runs/${runId}/log`)
    );
    expect(log.status).toBe(200);
    expect(log.headers.get('Content-Type')).toContain('text/event-stream');

    const body = await log.text();
    expect(body).toContain('"type":"exit"');
    expect(body).toContain('"status":"succeeded"');
    expect(ensured).toBe(true);
  });

  it('keeps a connected WSL upgrade on the out-of-band provisioner path', async () => {
    let ensured = false;
    const host = createLocalRuntimeHost({ runtimeVersion: '0.0.1-legacy', slot: 'wsl' });
    const { app, repository, manager } = createTestApp(
      {
        wsl: async (_definition, onUnavailable) => {
          const connection = await connectInProcessRuntime(host, { hubVersion: 'dev' });
          return {
            client: new RuntimeClient(connection.client, onUnavailable),
            close: () => connection.close(),
          };
        },
      },
      undefined,
      undefined,
      (runtimeManager) =>
        createRuntimeLifecycleService({
          manager: runtimeManager,
          provisioner: {
            ensure: () => {
              ensured = true;
              return Promise.resolve();
            },
            removeSlotBytes: async () => undefined,
            slotBytes: async () => null,
          },
          loadRuntimeAsset: () => {
            throw new Error('live update asset loading must not run for WSL');
          },
        })
    );
    await repository.create({
      id: 'wsl-connected-upgrade',
      userId: TEST_USER.id,
      name: 'Connected WSL',
      transportKind: 'wsl',
      config: { distro: 'Ubuntu' },
      enabled: true,
    });
    await manager.connect(TEST_USER.id, 'wsl-connected-upgrade');
    await manager.refreshManifest(TEST_USER.id, 'wsl-connected-upgrade');

    const started = await app.handle(
      new Request(
        'http://localhost/environments/wsl-connected-upgrade/runtime/install',
        jsonRequest('POST', { action: 'upgrade' })
      )
    );
    expect(started.status).toBe(200);
    const { runId } = (await started.json()) as { runId: string };
    const log = await app.handle(
      new Request(`http://localhost/environments/wsl-connected-upgrade/runtime/runs/${runId}/log`)
    );

    expect(await log.text()).toContain('"status":"succeeded"');
    expect(ensured).toBe(true);
    await manager.closeAll();
  });

  // Declining the install is not declining the download. The bytes are the
  // expensive, checksum-verified half of a provision; staging them costs the
  // target machine nothing and leaves somebody able to finish by hand.
  it('stages a verified runtime in the hub cache without touching the machine', async () => {
    const originalVersion = process.env.VERSION;
    // A checkout publishes no release to download from.
    process.env.VERSION = '9.9.9-test';
    try {
      let ensured = false;
      let loadedPlatformId: string | undefined;
      const host = createProvisionedRuntimeHost(
        { runtimeVersion: '0.0.1-old', slot: 'wsl' },
        'linux-x64-musl'
      );
      const { app, repository, manager } = createTestApp(
        {
          wsl: async (_definition, onUnavailable) => {
            const connection = await connectInProcessRuntime(host, { hubVersion: 'dev' });
            return {
              client: new RuntimeClient(connection.client, onUnavailable),
              close: () => connection.close(),
            };
          },
        },
        undefined,
        undefined,
        (runtimeManager) =>
          createRuntimeLifecycleService({
            manager: runtimeManager,
            provisioner: {
              ensure: () => {
                ensured = true;
                return Promise.resolve();
              },
              removeSlotBytes: async () => undefined,
              slotBytes: async () => null,
            },
            loadRuntimeAsset: (platformId) => {
              loadedPlatformId = platformId;
              return Promise.resolve({
                bytes: new TextEncoder().encode('verified-runtime-binary'),
                digest: 'sha256:0',
                fromArchive: false as const,
                cached: true,
                offlineCache: false,
              });
            },
          })
      );
      await repository.create({
        id: 'wsl-staged-download',
        userId: TEST_USER.id,
        name: 'Staged download',
        transportKind: 'wsl',
        config: { distro: 'Ubuntu' },
        enabled: true,
      });
      await manager.connect(TEST_USER.id, 'wsl-staged-download');
      await manager.refreshManifest(TEST_USER.id, 'wsl-staged-download');

      const started = await app.handle(
        new Request(
          'http://localhost/environments/wsl-staged-download/runtime/install',
          jsonRequest('POST', { action: 'download' })
        )
      );
      expect(started.status).toBe(200);
      const { runId } = (await started.json()) as { runId: string };
      const log = await app.handle(
        new Request(`http://localhost/environments/wsl-staged-download/runtime/runs/${runId}/log`)
      );
      const body = await log.text();

      expect(body).toContain('"status":"succeeded"');
      // The exact release identity, libc variant included — not `linux-x64`.
      expect(loadedPlatformId).toBe('linux-x64-musl');
      // The documented cache location, and a checksum line to check it with.
      expect(body).toContain('runtime-cache');
      expect(body).toContain('mangostudio-runtime-9.9.9-test-linux-x64-musl');
      expect(body).toContain('sha256sum -c -');
      // Nothing reached the distribution. `ensure` is the only path that writes
      // bytes into a WSL slot, so its not having run is the whole claim.
      expect(ensured).toBe(false);
      await manager.closeAll();
    } finally {
      if (originalVersion === undefined) delete process.env.VERSION;
      else process.env.VERSION = originalVersion;
    }
  });

  // Regression: on the archive-fallback branch the run named the cache
  // *directory* and printed no verify line at all — so the one thing staging
  // exists to produce, a path plus a command to check it with, went missing
  // exactly when the fallback fired. The raw asset it would otherwise have
  // named is not on disk in this case; only the archive is.
  it('names the archive it staged, and a checksum line for it, on the fallback path', async () => {
    const originalVersion = process.env.VERSION;
    process.env.VERSION = '9.9.9-test';
    try {
      const bytes = new TextEncoder().encode('verified-platform-archive');
      const hash = createHash('sha256').update(bytes).digest('hex');
      const host = createProvisionedRuntimeHost(
        { runtimeVersion: '0.0.1-old', slot: 'wsl' },
        'linux-x64-musl'
      );
      const { app, repository, manager } = createTestApp(
        {
          wsl: async (_definition, onUnavailable) => {
            const connection = await connectInProcessRuntime(host, { hubVersion: 'dev' });
            return {
              client: new RuntimeClient(connection.client, onUnavailable),
              close: () => connection.close(),
            };
          },
        },
        undefined,
        undefined,
        (runtimeManager) =>
          createRuntimeLifecycleService({
            manager: runtimeManager,
            provisioner: {
              ensure: async () => undefined,
              removeSlotBytes: async () => undefined,
              slotBytes: async () => null,
            },
            // What a release that publishes no standalone runtime for this
            // platform leaves in the cache: the platform archive instead.
            loadRuntimeAsset: () =>
              Promise.resolve({
                bytes,
                digest: `sha256:${hash}`,
                fromArchive: true as const,
                cached: true,
                offlineCache: false,
              }),
          })
      );
      await repository.create({
        id: 'wsl-staged-download-archive',
        userId: TEST_USER.id,
        name: 'Staged download archive fallback',
        transportKind: 'wsl',
        config: { distro: 'Ubuntu' },
        enabled: true,
      });
      await manager.connect(TEST_USER.id, 'wsl-staged-download-archive');
      await manager.refreshManifest(TEST_USER.id, 'wsl-staged-download-archive');

      const started = await app.handle(
        new Request(
          'http://localhost/environments/wsl-staged-download-archive/runtime/install',
          jsonRequest('POST', { action: 'download' })
        )
      );
      expect(started.status).toBe(200);
      const { runId } = (await started.json()) as { runId: string };
      const log = await app.handle(
        new Request(
          `http://localhost/environments/wsl-staged-download-archive/runtime/runs/${runId}/log`
        )
      );
      const body = await log.text();
      // Only what the run reported *after* the download settled. The opening
      // line names the raw asset legitimately — that is what the hub set out to
      // fetch, before the release turned out not to publish it.
      const [, ...reported] = body
        .split('\n\n')
        .flatMap((frame) =>
          frame.startsWith('data: ')
            ? [JSON.parse(frame.slice('data: '.length)) as { line?: string }]
            : []
        )
        .flatMap((event) => event.line ?? []);

      expect(body).toContain('"status":"succeeded"');
      // The file that is actually there, named in full — not just its directory.
      const archivePath = join(
        homedir(),
        '.mango/runtime-cache/9.9.9-test/mangostudio-9.9.9-test-linux-x64-musl.tar.gz'
      );
      expect(reported[0]).toContain(archivePath);
      // A checksum line, pinned to the digest this run just verified rather
      // than to a SHA256SUMS fetch a rolling tag can outrun, and checking the
      // archive where it actually landed.
      expect(reported[1]).toBe(`echo "${hash}  ${archivePath}" | sha256sum -c -`);
      // The raw runtime asset was never published for this platform, so nothing
      // the run reports may claim it is on disk.
      expect(reported.join('\n')).not.toContain('mangostudio-runtime-9.9.9-test');
      await manager.closeAll();
    } finally {
      if (originalVersion === undefined) delete process.env.VERSION;
      else process.env.VERSION = originalVersion;
    }
  });

  // The download-only action's whole point is a file left on disk. A hub
  // that cannot write its cache dir (full disk, permissions) must not report
  // success for bytes that only ever existed in memory.
  it('fails staging when the verified bytes cannot be written to the hub cache', async () => {
    const originalVersion = process.env.VERSION;
    process.env.VERSION = '9.9.9-test';
    try {
      const host = createProvisionedRuntimeHost(
        { runtimeVersion: '0.0.1-old', slot: 'wsl' },
        'linux-x64-musl'
      );
      const { app, repository, manager } = createTestApp(
        {
          wsl: async (_definition, onUnavailable) => {
            const connection = await connectInProcessRuntime(host, { hubVersion: 'dev' });
            return {
              client: new RuntimeClient(connection.client, onUnavailable),
              close: () => connection.close(),
            };
          },
        },
        undefined,
        undefined,
        (runtimeManager) =>
          createRuntimeLifecycleService({
            manager: runtimeManager,
            provisioner: {
              ensure: async () => undefined,
              removeSlotBytes: async () => undefined,
              slotBytes: async () => null,
            },
            loadRuntimeAsset: () =>
              Promise.resolve({
                bytes: new TextEncoder().encode('verified-runtime-binary'),
                digest: 'sha256:0',
                fromArchive: false as const,
                cached: false,
                offlineCache: false,
              }),
          })
      );
      await repository.create({
        id: 'wsl-staged-download-cache-failure',
        userId: TEST_USER.id,
        name: 'Staged download cache failure',
        transportKind: 'wsl',
        config: { distro: 'Ubuntu' },
        enabled: true,
      });
      await manager.connect(TEST_USER.id, 'wsl-staged-download-cache-failure');
      await manager.refreshManifest(TEST_USER.id, 'wsl-staged-download-cache-failure');

      const started = await app.handle(
        new Request(
          'http://localhost/environments/wsl-staged-download-cache-failure/runtime/install',
          jsonRequest('POST', { action: 'download' })
        )
      );
      expect(started.status).toBe(200);
      const { runId } = (await started.json()) as { runId: string };
      const log = await app.handle(
        new Request(
          `http://localhost/environments/wsl-staged-download-cache-failure/runtime/runs/${runId}/log`
        )
      );
      const body = await log.text();

      expect(body).toContain('"status":"failed"');
      expect(body).not.toContain('Verified and cached');
      await manager.closeAll();
    } finally {
      if (originalVersion === undefined) delete process.env.VERSION;
      else process.env.VERSION = originalVersion;
    }
  });

  // Before the run signal reached the loader, cancelling here only took effect
  // once the (up to 300s) download settled on its own: the run stayed active
  // and an immediate retry saw a conflict despite the cancel having "worked".
  it('cancels a staged download instead of waiting for it to finish on its own', async () => {
    const originalVersion = process.env.VERSION;
    process.env.VERSION = '9.9.9-test';
    try {
      let sawSignal: AbortSignal | undefined;
      const host = createProvisionedRuntimeHost(
        { runtimeVersion: '0.0.1-old', slot: 'wsl' },
        'linux-x64-musl'
      );
      let lifecycle: RuntimeLifecycleService | undefined;
      const { app, repository, manager } = createTestApp(
        {
          wsl: async (_definition, onUnavailable) => {
            const connection = await connectInProcessRuntime(host, { hubVersion: 'dev' });
            return {
              client: new RuntimeClient(connection.client, onUnavailable),
              close: () => connection.close(),
            };
          },
        },
        undefined,
        undefined,
        (runtimeManager) => {
          lifecycle = createRuntimeLifecycleService({
            manager: runtimeManager,
            provisioner: {
              ensure: async () => undefined,
              removeSlotBytes: async () => undefined,
              slotBytes: async () => null,
            },
            loadRuntimeAsset: (_platformId, options) => {
              sawSignal = options?.signal;
              return new Promise((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
                  once: true,
                });
              });
            },
          });
          return lifecycle;
        }
      );
      await repository.create({
        id: 'wsl-cancel-download',
        userId: TEST_USER.id,
        name: 'WSL cancel download',
        transportKind: 'wsl',
        config: { distro: 'Ubuntu' },
        enabled: true,
      });
      await manager.connect(TEST_USER.id, 'wsl-cancel-download');
      await manager.refreshManifest(TEST_USER.id, 'wsl-cancel-download');

      const started = await app.handle(
        new Request(
          'http://localhost/environments/wsl-cancel-download/runtime/install',
          jsonRequest('POST', { action: 'download' })
        )
      );
      expect(started.status).toBe(200);
      const { runId } = (await started.json()) as { runId: string };
      const log = await app.handle(
        new Request(`http://localhost/environments/wsl-cancel-download/runtime/runs/${runId}/log`)
      );

      const cancelled = await app.handle(
        new Request(
          `http://localhost/environments/wsl-cancel-download/runtime/runs/${runId}/cancel`,
          jsonRequest('POST')
        )
      );
      expect(cancelled.status).toBe(200);
      expect(await log.text()).toContain('"status":"cancelled"');
      // Not just that the run ended, but that the loader was the one told to stop.
      expect(sawSignal?.aborted).toBe(true);
      expect(lifecycle?.hasActiveInstall(TEST_USER.id, 'wsl-cancel-download')).toBe(false);
      await manager.closeAll();
    } finally {
      if (originalVersion === undefined) delete process.env.VERSION;
      else process.env.VERSION = originalVersion;
    }
  });

  // #798: a download registers a run so nothing else writes to the same log
  // stream, which is not the same thing as the environment being mid-mutation.
  // It used to be read as both, so pressing Download locked editing and
  // deleting for the length of the download.
  it('keeps a staged download from locking the environment out of editing', async () => {
    const originalVersion = process.env.VERSION;
    process.env.VERSION = '9.9.9-test';
    try {
      let sawSignal: AbortSignal | undefined;
      const host = createProvisionedRuntimeHost(
        { runtimeVersion: '0.0.1-old', slot: 'wsl' },
        'linux-x64-musl'
      );
      let lifecycle: RuntimeLifecycleService | undefined;
      const { app, repository, manager } = createTestApp(
        {
          wsl: async (_definition, onUnavailable) => {
            const connection = await connectInProcessRuntime(host, { hubVersion: 'dev' });
            return {
              client: new RuntimeClient(connection.client, onUnavailable),
              close: () => connection.close(),
            };
          },
        },
        undefined,
        {
          // The real answers, read through the lifecycle service this app
          // builds below — the point of the test is which runs count.
          hasActiveInstall: (userId, id) => lifecycle?.hasActiveInstall(userId, id) ?? false,
          cancelActiveRun: (userId, id) => lifecycle?.cancelForEnvironment(userId, id) ?? false,
        },
        (runtimeManager) => {
          lifecycle = createRuntimeLifecycleService({
            manager: runtimeManager,
            provisioner: {
              ensure: async () => undefined,
              removeSlotBytes: async () => undefined,
              slotBytes: async () => null,
            },
            loadRuntimeAsset: (_platformId, options) => {
              sawSignal = options?.signal;
              return new Promise((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
                  once: true,
                });
              });
            },
          });
          return lifecycle;
        }
      );
      await repository.create({
        id: 'wsl-download-lock',
        userId: TEST_USER.id,
        name: 'WSL download lock',
        transportKind: 'wsl',
        config: { distro: 'Ubuntu' },
        enabled: true,
      });
      await manager.connect(TEST_USER.id, 'wsl-download-lock');
      await manager.refreshManifest(TEST_USER.id, 'wsl-download-lock');

      const started = await app.handle(
        new Request(
          'http://localhost/environments/wsl-download-lock/runtime/install',
          jsonRequest('POST', { action: 'download' })
        )
      );
      expect(started.status).toBe(200);

      // A second run of any kind is still refused: one run owns the stream.
      const second = await app.handle(
        new Request(
          'http://localhost/environments/wsl-download-lock/runtime/install',
          jsonRequest('POST', { action: 'install' })
        )
      );
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({
        error: expect.stringContaining('download is already running'),
      });

      const renamed = await app.handle(
        new Request(
          'http://localhost/environments/wsl-download-lock',
          jsonRequest('PUT', { name: 'Renamed mid-download' } satisfies UpdateEnvironmentBody)
        )
      );
      expect(renamed.status).toBe(200);
      expect((await renamed.json()) as Environment).toMatchObject({
        name: 'Renamed mid-download',
      });

      const removed = await app.handle(
        new Request('http://localhost/environments/wsl-download-lock', jsonRequest('DELETE'))
      );
      expect(removed.status).toBe(200);
      // Deleted, and the run that was streaming about it stopped with it.
      expect(sawSignal?.aborted).toBe(true);
      expect(await repository.find(TEST_USER.id, 'wsl-download-lock')).toBeNull();
      await manager.closeAll();
    } finally {
      if (originalVersion === undefined) delete process.env.VERSION;
      else process.env.VERSION = originalVersion;
    }
  });

  // The other half of #798: a real install still writes to that machine, so it
  // still holds the environment against an edit or a delete.
  it('keeps refusing an edit or a delete while a real install runs', async () => {
    const host = createProvisionedRuntimeHost(
      { runtimeVersion: '0.0.1-old', slot: 'wsl' },
      'linux-x64-musl'
    );
    let lifecycle: RuntimeLifecycleService | undefined;
    const { app, repository, manager } = createTestApp(
      {
        wsl: async (_definition, onUnavailable) => {
          const connection = await connectInProcessRuntime(host, { hubVersion: 'dev' });
          return {
            client: new RuntimeClient(connection.client, onUnavailable),
            close: () => connection.close(),
          };
        },
      },
      undefined,
      {
        hasActiveInstall: (userId, id) => lifecycle?.hasActiveInstall(userId, id) ?? false,
        cancelActiveRun: (userId, id) => lifecycle?.cancelForEnvironment(userId, id) ?? false,
      },
      (runtimeManager) => {
        lifecycle = createRuntimeLifecycleService({
          manager: runtimeManager,
          provisioner: {
            // Still pushing bytes when the edit and the delete arrive.
            ensure: (_distro, options) =>
              new Promise((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
                  once: true,
                });
              }),
            removeSlotBytes: async () => undefined,
            slotBytes: async () => null,
          },
        });
        return lifecycle;
      }
    );
    await repository.create({
      id: 'wsl-install-lock',
      userId: TEST_USER.id,
      name: 'WSL install lock',
      transportKind: 'wsl',
      config: { distro: 'Ubuntu' },
      enabled: true,
    });
    await manager.connect(TEST_USER.id, 'wsl-install-lock');
    await manager.refreshManifest(TEST_USER.id, 'wsl-install-lock');

    const started = await app.handle(
      new Request(
        'http://localhost/environments/wsl-install-lock/runtime/install',
        jsonRequest('POST', { action: 'install' })
      )
    );
    expect(started.status).toBe(200);
    const { runId } = (await started.json()) as { runId: string };

    const renamed = await app.handle(
      new Request(
        'http://localhost/environments/wsl-install-lock',
        jsonRequest('PUT', { name: 'Renamed mid-install' } satisfies UpdateEnvironmentBody)
      )
    );
    expect(renamed.status).toBe(409);
    expect(await renamed.json()).toMatchObject({
      error: expect.stringContaining('runtime install in progress'),
    });

    const removed = await app.handle(
      new Request('http://localhost/environments/wsl-install-lock', jsonRequest('DELETE'))
    );
    expect(removed.status).toBe(409);
    expect(await repository.find(TEST_USER.id, 'wsl-install-lock')).not.toBeNull();

    await app.handle(
      new Request(
        `http://localhost/environments/wsl-install-lock/runtime/runs/${runId}/cancel`,
        jsonRequest('POST')
      )
    );
    await manager.closeAll();
  });

  it('updates a connected runtime over its existing protocol connection', async () => {
    const mangoHome = await mkdtemp(join(tmpdir(), 'mango-live-update-route-'));
    tempHomes.push(mangoHome);
    const env = { MANGO_HOME: mangoHome };
    const bytes = new TextEncoder().encode('verified-runtime-binary');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    let loadedPlatformId: string | undefined;
    const host = createProvisionedRuntimeHost(
      {
        runtimeVersion: '0.0.1-old',
        slot: 'host',
        update: { env },
      },
      'linux-x64-musl'
    );
    const { app, repository, manager } = createTestApp(
      {
        http: async (_definition, onUnavailable) => {
          const connection = await connectInProcessRuntime(host, { hubVersion: 'dev' });
          return {
            client: new RuntimeClient(connection.client, onUnavailable),
            close: () => connection.close(),
          };
        },
      },
      undefined,
      undefined,
      (runtimeManager) =>
        createRuntimeLifecycleService({
          manager: runtimeManager,
          loadRuntimeAsset: (platformId) => {
            loadedPlatformId = platformId;
            return Promise.resolve({
              bytes,
              digest,
              fromArchive: false as const,
              cached: true,
              offlineCache: false,
            });
          },
        })
    );
    await repository.create({
      id: 'http-live-update',
      userId: TEST_USER.id,
      name: 'LAN runtime',
      transportKind: 'http',
      config: { baseUrl: 'http://runtime.test' },
      enabled: true,
    });
    await manager.connect(TEST_USER.id, 'http-live-update');
    await manager.refreshManifest(TEST_USER.id, 'http-live-update');

    const viewResponse = await app.handle(
      new Request('http://localhost/environments/http-live-update/runtime')
    );
    const view = (await viewResponse.json()) as RuntimeLifecycleView;
    expect(view.actions).toEqual(['upgrade']);

    const started = await app.handle(
      new Request(
        'http://localhost/environments/http-live-update/runtime/install',
        jsonRequest('POST', { action: 'upgrade' })
      )
    );
    expect(started.status).toBe(200);
    const { runId } = (await started.json()) as { runId: string };
    const log = await app.handle(
      new Request(`http://localhost/environments/http-live-update/runtime/runs/${runId}/log`)
    );
    const body = await log.text();

    expect(body).toContain('"status":"succeeded"');
    expect(body).toContain('Restart this manually launched runtime');
    expect(loadedPlatformId).toBe('linux-x64-musl');
    expect(
      await readFile(join(mangoHome, 'runtime', 'host', 'current', 'mangostudio-runtime'), 'utf8')
    ).toBe('verified-runtime-binary');
  });

  // An open session refuses every ordinary call until it expires, and there is
  // deliberately no fourth protocol method to abandon one. Dropping the
  // connection is the whole cleanup path, so a transfer that dies before the
  // peer answered has to take it.
  it('drops the connection when a live update dies mid-transfer', async () => {
    const mangoHome = await mkdtemp(join(tmpdir(), 'mango-stalled-update-route-'));
    tempHomes.push(mangoHome);
    const env = { MANGO_HOME: mangoHome };
    const bytes = new TextEncoder().encode('a'.repeat(96 * 1024));
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    let releaseWrite: (() => void) | undefined;
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let firstWrite: (() => void) | undefined;
    const reachedTransfer = new Promise<void>((resolve) => {
      firstWrite = resolve;
    });
    let stalled = false;

    const host = createProvisionedRuntimeHost(
      {
        runtimeVersion: '0.0.1-old',
        slot: 'host',
        update: {
          env,
          writeChunk: async (handle, chunk) => {
            if (!stalled) {
              stalled = true;
              firstWrite?.();
              await writeBlocked;
            }
            return (await handle.write(chunk)).bytesWritten;
          },
        },
      },
      'linux-x64'
    );
    const { app, repository, manager } = createTestApp(
      {
        http: async (_definition, onUnavailable) => {
          const connection = await connectInProcessRuntime(host, { hubVersion: 'dev' });
          return {
            client: new RuntimeClient(connection.client, onUnavailable),
            close: () => connection.close(),
          };
        },
      },
      undefined,
      undefined,
      (runtimeManager) =>
        createRuntimeLifecycleService({
          manager: runtimeManager,
          loadRuntimeAsset: () =>
            Promise.resolve({
              bytes,
              digest,
              fromArchive: false as const,
              cached: true,
              offlineCache: false,
            }),
        })
    );
    await repository.create({
      id: 'http-stalled-update',
      userId: TEST_USER.id,
      name: 'Stalled runtime update',
      transportKind: 'http',
      config: { baseUrl: 'http://runtime.test' },
      enabled: true,
    });
    await manager.connect(TEST_USER.id, 'http-stalled-update');
    await manager.refreshManifest(TEST_USER.id, 'http-stalled-update');

    const started = await app.handle(
      new Request(
        'http://localhost/environments/http-stalled-update/runtime/install',
        jsonRequest('POST', { action: 'upgrade' })
      )
    );
    const { runId } = (await started.json()) as { runId: string };
    const log = await app.handle(
      new Request(`http://localhost/environments/http-stalled-update/runtime/runs/${runId}/log`)
    );
    const logBody = log.text();
    await reachedTransfer;

    const cancelled = await app.handle(
      new Request(
        `http://localhost/environments/http-stalled-update/runtime/runs/${runId}/cancel`,
        jsonRequest('POST')
      )
    );
    expect(cancelled.status).toBe(200);
    releaseWrite?.();
    expect(await logBody).toContain('"status":"cancelled"');

    // `cancel` closes the run stream up front and lets the transfer unwind on
    // its own, so the release lands after the log has already said cancelled.
    for (
      let attempt = 0;
      attempt < 50 && manager.getStatus(TEST_USER.id, 'http-stalled-update').state === 'connected';
      attempt += 1
    ) {
      await Bun.sleep(20);
    }
    expect(manager.getStatus(TEST_USER.id, 'http-stalled-update').state).toBe('disconnected');
    expect(
      await readFile(join(mangoHome, 'runtime', 'host', 'current', 'mangostudio-runtime'), 'utf8')
        .then(() => 'published')
        .catch(() => 'absent')
    ).toBe('absent');
    await manager.closeAll();
  });

  // A runtime that answered is a runtime that is still serving. Dropping it
  // would turn a refused upgrade into an outage, and leaving `updating` behind
  // would let the card claim a handoff that is never coming.
  it('keeps the connection and the old binary when a live update is refused', async () => {
    const mangoHome = await mkdtemp(join(tmpdir(), 'mango-refused-update-route-'));
    tempHomes.push(mangoHome);
    const env = { MANGO_HOME: mangoHome };
    const bytes = new TextEncoder().encode('tampered-runtime-binary');
    const wrongDigest = `sha256:${'0'.repeat(64)}`;
    const host = createProvisionedRuntimeHost(
      { runtimeVersion: '0.0.1-old', slot: 'host', update: { env } },
      'linux-x64'
    );
    const { app, repository, manager } = createTestApp(
      {
        http: async (_definition, onUnavailable) => {
          const connection = await connectInProcessRuntime(host, { hubVersion: 'dev' });
          return {
            client: new RuntimeClient(connection.client, onUnavailable),
            close: () => connection.close(),
          };
        },
      },
      undefined,
      undefined,
      (runtimeManager) =>
        createRuntimeLifecycleService({
          manager: runtimeManager,
          loadRuntimeAsset: () =>
            Promise.resolve({
              bytes,
              digest: wrongDigest,
              fromArchive: false as const,
              cached: true,
              offlineCache: false,
            }),
        })
    );
    await repository.create({
      id: 'http-refused-update',
      userId: TEST_USER.id,
      name: 'LAN runtime',
      transportKind: 'http',
      config: { baseUrl: 'http://runtime.test' },
      enabled: true,
    });
    await manager.connect(TEST_USER.id, 'http-refused-update');
    await manager.refreshManifest(TEST_USER.id, 'http-refused-update');

    const started = await app.handle(
      new Request(
        'http://localhost/environments/http-refused-update/runtime/install',
        jsonRequest('POST', { action: 'upgrade' })
      )
    );
    expect(started.status).toBe(200);
    const { runId } = (await started.json()) as { runId: string };
    const log = await app.handle(
      new Request(`http://localhost/environments/http-refused-update/runtime/runs/${runId}/log`)
    );
    const body = await log.text();

    expect(body).toContain('"status":"failed"');
    expect(body).toContain('digest mismatch');
    // Nothing published: `current` never existed on this slot, so a swap would
    // have created it.
    expect(
      await readFile(join(mangoHome, 'runtime', 'host', 'current', 'mangostudio-runtime'), 'utf8')
        .then(() => 'published')
        .catch(() => 'absent')
    ).toBe('absent');
    const status = manager.getStatus(TEST_USER.id, 'http-refused-update');
    expect(status.state).toBe('connected');
    expect(status.updating).toBeUndefined();

    // The refusal ended the session too, so the runtime still answers.
    const client = await manager.getClient(TEST_USER.id, 'http-refused-update');
    await expect(client.health()).resolves.toMatchObject({ runtimeVersion: '0.0.1-old' });
  });

  it('reconnects a supervised runtime and verifies the new handshake version', async () => {
    const mangoHome = await mkdtemp(join(tmpdir(), 'mango-supervised-update-route-'));
    tempHomes.push(mangoHome);
    const env = { MANGO_HOME: mangoHome };
    const bytes = new TextEncoder().encode('supervised-runtime-binary');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const targetVersion = getVersion();
    let connectionCount = 0;
    let activeConnection: { close(): void } | undefined;

    const { app, repository, manager } = createTestApp(
      {
        http: async (_definition, onUnavailable) => {
          connectionCount += 1;
          const firstConnection = connectionCount === 1;
          const host = createProvisionedRuntimeHost({
            runtimeVersion: firstConnection ? '0.0.1-old' : targetVersion,
            ...(firstConnection
              ? {
                  slot: 'host' as const,
                  update: {
                    env,
                    supervised: true,
                    requestRestart: () => {
                      activeConnection?.close();
                      onUnavailable();
                    },
                  },
                }
              : {}),
          });
          const connection = await connectInProcessRuntime(host, { hubVersion: 'dev' });
          activeConnection = connection;
          return {
            client: new RuntimeClient(connection.client, onUnavailable),
            close: () => connection.close(),
          };
        },
      },
      undefined,
      undefined,
      (runtimeManager) =>
        createRuntimeLifecycleService({
          manager: runtimeManager,
          loadRuntimeAsset: () =>
            Promise.resolve({
              bytes,
              digest,
              fromArchive: false as const,
              cached: true,
              offlineCache: false,
            }),
        })
    );
    await repository.create({
      id: 'http-supervised-update',
      userId: TEST_USER.id,
      name: 'Supervised runtime',
      transportKind: 'http',
      config: { baseUrl: 'http://runtime.test' },
      enabled: true,
    });
    await manager.connect(TEST_USER.id, 'http-supervised-update');
    await manager.refreshManifest(TEST_USER.id, 'http-supervised-update');

    const started = await app.handle(
      new Request(
        'http://localhost/environments/http-supervised-update/runtime/install',
        jsonRequest('POST', { action: 'upgrade' })
      )
    );
    const { runId } = (await started.json()) as { runId: string };
    const log = await app.handle(
      new Request(`http://localhost/environments/http-supervised-update/runtime/runs/${runId}/log`)
    );
    const body = await log.text();

    expect(body).toContain(`Runtime reconnected on ${targetVersion}; version drift cleared.`);
    expect(body).toContain('"status":"succeeded"');
    expect(connectionCount).toBe(2);
    expect(manager.getStatus(TEST_USER.id, 'http-supervised-update')).toMatchObject({
      state: 'connected',
      runtimeVersion: targetVersion,
      runtimeVersionDrift: false,
    });
    await manager.closeAll();
  });

  it('cancels restart waiting without disconnecting a replacement client', async () => {
    const mangoHome = await mkdtemp(join(tmpdir(), 'mango-cancelled-update-route-'));
    tempHomes.push(mangoHome);
    const env = { MANGO_HOME: mangoHome };
    const bytes = new TextEncoder().encode('cancelled-update-runtime');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const targetVersion = getVersion();
    let replacement = false;
    let restartRequested: (() => void) | undefined;
    const restartRequest = new Promise<void>((resolve) => {
      restartRequested = resolve;
    });

    const { app, repository, manager } = createTestApp(
      {
        http: async (_definition, onUnavailable) => {
          const host = createProvisionedRuntimeHost({
            runtimeVersion: replacement ? targetVersion : '0.0.1-old',
            ...(!replacement
              ? {
                  slot: 'host' as const,
                  update: {
                    env,
                    supervised: true,
                    requestRestart: () => restartRequested?.(),
                  },
                }
              : {}),
          });
          const connection = await connectInProcessRuntime(host, { hubVersion: 'dev' });
          return {
            client: new RuntimeClient(connection.client, onUnavailable),
            close: () => connection.close(),
          };
        },
      },
      undefined,
      undefined,
      (runtimeManager) =>
        createRuntimeLifecycleService({
          manager: runtimeManager,
          loadRuntimeAsset: () =>
            Promise.resolve({
              bytes,
              digest,
              fromArchive: false as const,
              cached: true,
              offlineCache: false,
            }),
        })
    );
    await repository.create({
      id: 'http-cancelled-update',
      userId: TEST_USER.id,
      name: 'Cancelled runtime update',
      transportKind: 'http',
      config: { baseUrl: 'http://runtime.test' },
      enabled: true,
    });
    await manager.connect(TEST_USER.id, 'http-cancelled-update');
    await manager.refreshManifest(TEST_USER.id, 'http-cancelled-update');

    const started = await app.handle(
      new Request(
        'http://localhost/environments/http-cancelled-update/runtime/install',
        jsonRequest('POST', { action: 'upgrade' })
      )
    );
    const { runId } = (await started.json()) as { runId: string };
    const log = await app.handle(
      new Request(`http://localhost/environments/http-cancelled-update/runtime/runs/${runId}/log`)
    );
    const logBody = log.text();
    await restartRequest;

    manager.disconnect(TEST_USER.id, 'http-cancelled-update');
    replacement = true;
    const replacementClient = await manager.connect(TEST_USER.id, 'http-cancelled-update', {
      force: true,
    });
    const originalDisconnectIfCurrent = manager.disconnectIfCurrent.bind(manager);
    let staleDisconnectAttempts = 0;
    manager.disconnectIfCurrent = (...args) => {
      staleDisconnectAttempts += 1;
      return originalDisconnectIfCurrent(...args);
    };

    const cancelled = await app.handle(
      new Request(
        `http://localhost/environments/http-cancelled-update/runtime/runs/${runId}/cancel`,
        jsonRequest('POST')
      )
    );
    expect(cancelled.status).toBe(200);
    expect(await logBody).toContain('"status":"cancelled"');

    // The commit already landed and the runtime is restarting onto it, so there
    // is no staged session left to free: cancelling here must not reach for the
    // connection at all, least of all the replacement that took its place.
    expect(staleDisconnectAttempts).toBe(0);
    expect(manager.getStatus(TEST_USER.id, 'http-cancelled-update').state).toBe('connected');
    expect(await manager.getClient(TEST_USER.id, 'http-cancelled-update')).toBe(replacementClient);
    await manager.closeAll();
  });

  it('cancels an in-flight runtime install via the cancel route', async () => {
    let releaseEnsure: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseEnsure = resolve;
    });
    const { app, repository, lifecycle } = (() => {
      const lifecycle = createRuntimeLifecycleService({
        provisioner: {
          ensure: async (_distro, options) => {
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => reject(new Error('cancelled'));
              options?.signal?.addEventListener('abort', onAbort, { once: true });
              void blocked.then(() => {
                options?.signal?.removeEventListener('abort', onAbort);
                resolve();
              });
            });
          },
          removeSlotBytes: async () => undefined,
          slotBytes: async () => null,
        },
      });
      const created = createTestApp({}, lifecycle);
      return { ...created, lifecycle };
    })();
    await repository.create({
      id: 'wsl-cancel',
      userId: TEST_USER.id,
      name: 'WSL cancel',
      transportKind: 'wsl',
      config: { distro: 'Ubuntu' },
      enabled: true,
    });

    const started = await app.handle(
      new Request(
        'http://localhost/environments/wsl-cancel/runtime/install',
        jsonRequest('POST', { action: 'install' })
      )
    );
    expect(started.status).toBe(200);
    const { runId } = (await started.json()) as { runId: string };

    const cancelled = await app.handle(
      new Request(
        `http://localhost/environments/wsl-cancel/runtime/runs/${runId}/cancel`,
        jsonRequest('POST')
      )
    );
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ runId, cancellationRequested: true });
    expect(lifecycle.hasActiveInstall(TEST_USER.id, 'wsl-cancel')).toBe(false);
    releaseEnsure?.();
  });

  it('refuses card install for Local and stdio', async () => {
    const { app, repository } = createTestApp();
    await repository.create({
      id: 'stdio-box',
      userId: TEST_USER.id,
      name: 'Stdio',
      transportKind: 'stdio',
      config: {},
      enabled: true,
    });

    const local = await app.handle(
      new Request(
        'http://localhost/environments/local/runtime/install',
        jsonRequest('POST', { action: 'install' })
      )
    );
    expect(local.status).toBe(409);

    const stdio = await app.handle(
      new Request(
        'http://localhost/environments/stdio-box/runtime/install',
        jsonRequest('POST', { action: 'install' })
      )
    );
    expect(stdio.status).toBe(409);
  });

  it('removes runtime bytes only when asked, and never for a 404', async () => {
    const removed: string[] = [];
    const { app, repository } = createTestApp({}, undefined, {
      removeRuntimeBytes: (record) => {
        removed.push(record.id);
        return Promise.resolve();
      },
    });
    for (const id of ['wsl-keep', 'wsl-wipe']) {
      await repository.create({
        id,
        userId: TEST_USER.id,
        name: id,
        transportKind: 'wsl',
        config: { distro: 'Ubuntu' },
        enabled: true,
      });
    }

    const kept = await app.handle(
      new Request('http://localhost/environments/wsl-keep', jsonRequest('DELETE'))
    );
    expect(kept.status).toBe(200);
    expect(removed).toEqual([]);

    const wiped = await app.handle(
      new Request(
        'http://localhost/environments/wsl-wipe?removeRuntime=true',
        jsonRequest('DELETE')
      )
    );
    expect(wiped.status).toBe(200);
    expect(removed).toEqual(['wsl-wipe']);

    const missing = await app.handle(
      new Request(
        'http://localhost/environments/missing-env?removeRuntime=true',
        jsonRequest('DELETE')
      )
    );
    expect(missing.status).toBe(404);
    expect(removed).toEqual(['wsl-wipe']);
  });

  it('surfaces a failed byte removal as 503 and keeps the environment', async () => {
    const { app, repository } = createTestApp({}, undefined, {
      removeRuntimeBytes: () => Promise.reject(new Error('distribution is not running')),
    });
    await repository.create({
      id: 'wsl-fail',
      userId: TEST_USER.id,
      name: 'WSL fail',
      transportKind: 'wsl',
      config: { distro: 'Ubuntu' },
      enabled: true,
    });

    const response = await app.handle(
      new Request(
        'http://localhost/environments/wsl-fail?removeRuntime=true',
        jsonRequest('DELETE')
      )
    );

    expect(response.status).toBe(503);
    // Cleanup runs before the DB delete precisely so this stays retriable.
    expect(await repository.find(TEST_USER.id, 'wsl-fail')).not.toBeNull();
  });

  // Regression: the reference preflight used to run *after* `manager.disconnect`,
  // so a delete that was going to be refused tore down a live runtime on its way
  // to the 409.
  it('leaves a referenced environment connected when the delete is refused', async () => {
    const removed: string[] = [];
    const { app, repository, manager } = createTestApp({}, undefined, {
      removeRuntimeBytes: (record) => {
        removed.push(record.id);
        return Promise.resolve();
      },
    });
    await repository.create({
      id: 'wsl-referenced',
      userId: TEST_USER.id,
      name: 'WSL referenced',
      transportKind: 'wsl',
      config: { distro: 'Ubuntu' },
      enabled: true,
    });
    await insertTestUser(TEST_USER);
    await getDb()
      .insertInto('chats')
      .values({
        id: 'chat-holding-env',
        title: 'holds the environment',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: TEST_USER.id,
        environmentId: 'wsl-referenced',
      })
      .execute();

    let disconnected = false;
    const realDisconnect = manager.disconnect.bind(manager);
    manager.disconnect = (userId: string, id: string) => {
      disconnected = true;
      return realDisconnect(userId, id);
    };

    const response = await app.handle(
      new Request(
        'http://localhost/environments/wsl-referenced?removeRuntime=true',
        jsonRequest('DELETE')
      )
    );

    expect(response.status).toBe(409);
    expect(disconnected).toBe(false);
    expect(removed).toEqual([]);
    expect(await repository.find(TEST_USER.id, 'wsl-referenced')).not.toBeNull();
  });
});
