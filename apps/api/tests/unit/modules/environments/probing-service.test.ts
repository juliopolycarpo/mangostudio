import { describe, expect, it } from 'bun:test';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import {
  createEnvironmentProbingService,
  type ProbeScope,
} from '../../../../src/modules/environments/application/probing-service';
import type { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';

const LOCAL: ProbeScope = { userId: 'ada', environmentId: 'local' };
const WSL: ProbeScope = { userId: 'ada', environmentId: 'ubuntu' };

const MANIFEST = { platform: 'linux' } as RuntimeCapabilityManifest;

interface FakeClient {
  client: RuntimeClient;
  runtimeCalls: number;
  agentCalls: number;
  version: string;
  selfParams: unknown;
  pathEnvParams: unknown;
  /** Leaves `probing.runtimes` pending so a second caller can race it. */
  holdRuntime: boolean;
  settleRuntime: () => void;
}

/**
 * Stands in for one runtime connection. A second instance is a reconnect: the
 * hub cache keys on identity, so handing out a new one is exactly what a
 * restarted machine looks like from up here.
 */
function fakeClient(version = 'v1'): FakeClient {
  const state: FakeClient = {
    client: null as unknown as RuntimeClient,
    runtimeCalls: 0,
    agentCalls: 0,
    version,
    selfParams: null,
    pathEnvParams: null,
    holdRuntime: false,
    settleRuntime: () => undefined,
  };
  const pendingRuntime: Array<(value: unknown) => void> = [];

  const client = {
    manifest: MANIFEST,
    runtimeVersion: '2.0.0-remote',
    probing: {
      runtimes: (params: { pathEnv?: unknown }) => {
        state.runtimeCalls += 1;
        state.pathEnvParams = params.pathEnv ?? null;
        return new Promise((resolve) => {
          pendingRuntime.push(resolve);
          if (!state.holdRuntime) settleRuntime();
        });
      },
      versionManagers: () =>
        Promise.resolve({
          statuses: [{ id: 'nvm', installed: false, versions: [], findings: [] }],
        }),
      agentClis: (params: { self?: unknown; pathEnv?: unknown }) => {
        state.agentCalls += 1;
        state.selfParams = params.self ?? null;
        state.pathEnvParams = params.pathEnv ?? null;
        return Promise.resolve({ statuses: [{ targetId: 'claude', id: 'claude' }] });
      },
    },
  } as unknown as RuntimeClient;

  function settleRuntime() {
    const statuses = [
      { id: 'bun', effective: { version: state.version } },
      { id: 'node', effective: { version: state.version } },
    ];
    for (const resolve of pendingRuntime.splice(0)) resolve({ statuses });
  }

  state.client = client;
  state.settleRuntime = settleRuntime;
  return state;
}

function serviceFor(clientFor: (scope: ProbeScope) => FakeClient, now = () => 1_000) {
  return createEnvironmentProbingService({
    resolveClient: (scope) => Promise.resolve(clientFor(scope).client),
    loadReleaseMetadata: () => Promise.resolve(null),
    getSelfVersion: () => '9.9.9',
    now,
  });
}

describe('environment probing cache', () => {
  it('serves a second read from cache and re-probes on force', async () => {
    const local = fakeClient();
    const service = serviceFor(() => local);

    await service.listRuntimeStatuses(LOCAL);
    await service.listRuntimeStatuses(LOCAL);
    expect(local.runtimeCalls).toBe(1);

    await service.listRuntimeStatuses(LOCAL, { force: true });
    expect(local.runtimeCalls).toBe(2);
  });

  it('expires an entry once the TTL has passed', async () => {
    const local = fakeClient();
    let clock = 1_000;
    const service = serviceFor(
      () => local,
      () => clock
    );

    await service.listRuntimeStatuses(LOCAL);
    clock += 60_000;
    await service.listRuntimeStatuses(LOCAL);

    expect(local.runtimeCalls).toBe(2);
  });

  it('drops what a reconnected runtime answered before it reconnected', async () => {
    let current = fakeClient('v1');
    const service = serviceFor(() => current);

    const first = await service.getRuntimeStatus(LOCAL, 'node');
    expect(first?.effective?.version).toBe('v1');

    // A new connection object is what a restarted machine looks like from here.
    current = fakeClient('v2');
    const afterReconnect = await service.getRuntimeStatus(LOCAL, 'node');

    expect(afterReconnect?.effective?.version).toBe('v2');
    expect(current.runtimeCalls).toBe(1);
  });

  it('keeps environments apart instead of answering one with the other', async () => {
    const clients = new Map([
      [LOCAL.environmentId, fakeClient('local-node')],
      [WSL.environmentId, fakeClient('wsl-node')],
    ]);
    const service = serviceFor((scope) => clients.get(scope.environmentId) as FakeClient);

    const local = await service.getRuntimeStatus(LOCAL, 'node');
    const wsl = await service.getRuntimeStatus(WSL, 'node');

    expect(local?.effective?.version).toBe('local-node');
    expect(wsl?.effective?.version).toBe('wsl-node');
    expect(clients.get(WSL.environmentId)?.runtimeCalls).toBe(1);
  });

  it('keeps two users apart even when they name their environment the same', async () => {
    const clients = new Map([
      ['ada', fakeClient('ada-node')],
      ['grace', fakeClient('grace-node')],
    ]);
    const service = serviceFor((scope) => clients.get(scope.userId) as FakeClient);

    const ada = await service.getRuntimeStatus({ userId: 'ada', environmentId: 'box' }, 'node');
    const grace = await service.getRuntimeStatus({ userId: 'grace', environmentId: 'box' }, 'node');

    expect(ada?.effective?.version).toBe('ada-node');
    expect(grace?.effective?.version).toBe('grace-node');
  });

  it('deduplicates concurrent lazy probes and never folds a forced one into them', async () => {
    const local = fakeClient();
    local.holdRuntime = true;
    const service = serviceFor(() => local);

    const first = service.listRuntimeStatuses(LOCAL);
    const concurrent = service.listRuntimeStatuses(LOCAL);
    await Promise.resolve();
    await Promise.resolve();
    expect(local.runtimeCalls).toBe(1);

    const forced = service.listRuntimeStatuses(LOCAL, { force: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(local.runtimeCalls).toBe(2);

    local.settleRuntime();
    await Promise.all([first, concurrent, forced]);
  });

  it('forgets one environment on reset and leaves the others alone', async () => {
    const clients = new Map([
      [LOCAL.environmentId, fakeClient()],
      [WSL.environmentId, fakeClient()],
    ]);
    const service = serviceFor((scope) => clients.get(scope.environmentId) as FakeClient);

    await service.listRuntimeStatuses(LOCAL);
    await service.listRuntimeStatuses(WSL);
    service.resetCache(WSL.environmentId);
    await service.listRuntimeStatuses(LOCAL);
    await service.listRuntimeStatuses(WSL);

    expect(clients.get(LOCAL.environmentId)?.runtimeCalls).toBe(1);
    expect(clients.get(WSL.environmentId)?.runtimeCalls).toBe(2);
  });

  it('answers null for an id this release holds no definition for', async () => {
    const local = fakeClient();
    const service = serviceFor(() => local);

    expect(await service.getVersionManagerStatus(LOCAL, 'fnm')).toBeNull();
    expect(await service.getVersionManagerStatus(LOCAL, 'volta')).toBeNull();
    expect(local.runtimeCalls).toBe(0);
  });
});

describe('what the hub sends down with a probe', () => {
  it('pins its own configured library directories and identity for its own machine', async () => {
    const local = fakeClient();
    const service = serviceFor(() => local);

    await service.listAgentCliStatuses(LOCAL);

    expect(local.selfParams).toMatchObject({ version: '9.9.9' });
    expect(local.selfParams).toHaveProperty('configHome');
    expect(local.pathEnvParams).toHaveProperty('env');
  });

  it('sends no hub paths to a machine where they would name nothing', async () => {
    const remote = fakeClient();
    const service = serviceFor(() => remote);

    await service.listAgentCliStatuses(WSL);

    // Remote mangostudio identity is the handshake version of that machine,
    // not the hub release that would be wrong on every peer.
    expect(remote.selfParams).toEqual({ version: '2.0.0-remote' });
    expect(remote.pathEnvParams).toBeNull();
  });
});
