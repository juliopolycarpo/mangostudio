import { describe, expect, it } from 'bun:test';
import { LIBRARY_LOCATION_DEFINITIONS } from '@mangostudio/shared/library/host';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import {
  createEnvironmentProbingService,
  type ProbeScope,
} from '../../../../src/modules/environments/application/probing-service';
import { LibraryFeatureUnavailableError } from '../../../../src/modules/library/domain/library-feature-error';
import type { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';

const LOCAL: ProbeScope = { userId: 'ada', environmentId: 'local' };
const WSL: ProbeScope = { userId: 'ada', environmentId: 'ubuntu' };

// `features.library` is real here because the location probe guards on it:
// a fake without it would make every location test throw inside the guard.
const MANIFEST = { platform: 'linux', features: { library: true } } as RuntimeCapabilityManifest;

interface FakeClient {
  client: RuntimeClient;
  runtimeCalls: number;
  agentCalls: number;
  locationCalls: number;
  version: string;
  selfParams: unknown;
  pathEnvParams: unknown;
  /** The `ids` the last `probing.runtimes` call was asked for. */
  lastRuntimeIds: readonly string[];
  /** Leaves `probing.runtimes` pending so a second caller can race it. */
  holdRuntime: boolean;
  settleRuntime: () => void;
  /** Same, for `probing.agentClis`, which also carries location statuses. */
  holdAgent: boolean;
  settleAgent: () => void;
  /**
   * Stamped onto every location status at the moment the runtime is asked, so
   * a held answer stays distinguishable from one taken after it.
   */
  locationEntryCount: number;
}

/**
 * Stands in for one runtime connection. A second instance is a reconnect: the
 * hub cache keys on identity, so handing out a new one is exactly what a
 * restarted machine looks like from up here. `platform` defaults to the
 * shared `MANIFEST`'s `linux`; passing `win32` is how the platform-aware
 * runtime-id tests get a manifest that asks for `winget` too.
 */
function fakeClient(version = 'v1', platform = MANIFEST.platform): FakeClient {
  const state: FakeClient = {
    client: null as unknown as RuntimeClient,
    runtimeCalls: 0,
    agentCalls: 0,
    locationCalls: 0,
    version,
    selfParams: null,
    pathEnvParams: null,
    lastRuntimeIds: [],
    holdRuntime: false,
    settleRuntime: () => undefined,
    holdAgent: false,
    settleAgent: () => undefined,
    locationEntryCount: 0,
  };
  const pendingRuntime: Array<(value: unknown) => void> = [];
  const pendingAgent: Array<(value: unknown) => void> = [];

  const client = {
    manifest: { ...MANIFEST, platform },
    runtimeVersion: '2.0.0-remote',
    probing: {
      runtimes: (params: { ids?: readonly string[]; pathEnv?: unknown }) => {
        state.runtimeCalls += 1;
        state.lastRuntimeIds = params.ids ?? [];
        state.pathEnvParams = params.pathEnv ?? null;
        return new Promise((resolve) => {
          pendingRuntime.push(resolve);
          if (!state.holdRuntime) settleRuntime();
        });
      },
      // Answers exactly the ids it was asked for, the way a real runtime does:
      // `getVersionManagerStatus` destructures the first entry it gets back, so
      // a fake that always returned the same fixed list regardless of `ids`
      // would hand a `fnm` caller an `nvm` status wearing the wrong label.
      versionManagers: (params: { ids?: readonly string[] }) => {
        const known: Record<
          string,
          { id: string; installed: boolean; versions: never[]; findings: never[] }
        > = {
          nvm: { id: 'nvm', installed: false, versions: [], findings: [] },
          fnm: { id: 'fnm', installed: false, versions: [], findings: [] },
        };
        const wanted = params.ids ?? ['nvm', 'fnm'];
        return Promise.resolve({
          statuses: wanted.map((id) => known[id]).filter((status) => status !== undefined),
        });
      },
      agentClis: (params: { self?: unknown; pathEnv?: unknown }) => {
        state.agentCalls += 1;
        state.selfParams = params.self ?? null;
        state.pathEnvParams = params.pathEnv ?? null;
        // Snapshotted now, not at settle time: a held scan answers with what
        // the machine looked like when it was asked.
        agentStatuses = [{ targetId: 'claude', id: 'claude', locations: locationStatuses(state) }];
        return new Promise((resolve) => {
          pendingAgent.push(resolve);
          if (!state.holdAgent) settleAgent();
        });
      },
    },
    library: {
      locations: () => {
        state.locationCalls += 1;
        return Promise.resolve({
          locations: locationStatuses(state),
        });
      },
    },
  } as unknown as RuntimeClient;

  let agentStatuses: unknown[] = [];

  function settleAgent() {
    for (const resolve of pendingAgent.splice(0)) resolve({ statuses: agentStatuses });
  }

  function settleRuntime() {
    // One status per id the requested platform's runtime list asks for — a
    // real runtime answers every requested id (reporting `missing` health for
    // a tool it does not have), and the cache only serves a lazy read once
    // every requested id has an entry. Leaving one out here would force a
    // re-probe on every read. `installations` is non-empty for bun/node —
    // matching their `effective` entry — so the prerequisite-findings pass
    // that reads every status in the batch sees a real "installed" shape
    // rather than a fixture-only gap.
    const statuses = [
      {
        id: 'bun',
        effective: { version: state.version },
        installations: [
          {
            path: '/bun',
            rawPath: '/bun',
            version: state.version,
            origin: 'path',
            effective: true,
          },
        ],
        findings: [],
      },
      {
        id: 'node',
        effective: { version: state.version },
        installations: [
          {
            path: '/node',
            rawPath: '/node',
            version: state.version,
            origin: 'path',
            effective: true,
          },
        ],
        findings: [],
      },
      { id: 'fnm', health: 'missing', installations: [], findings: [] },
      { id: 'winget', health: 'missing', installations: [], findings: [] },
      { id: 'git', health: 'missing', installations: [], findings: [] },
    ];
    for (const resolve of pendingRuntime.splice(0)) resolve({ statuses });
  }

  state.client = client;
  state.settleRuntime = settleRuntime;
  state.settleAgent = settleAgent;
  return state;
}

function locationStatuses(state: Pick<FakeClient, 'locationEntryCount'>) {
  return LIBRARY_LOCATION_DEFINITIONS.map((definition) => ({
    id: definition.id,
    kind: definition.kind,
    scope: definition.scope,
    exists: true,
    entryCount: state.locationEntryCount,
  }));
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

    expect(await service.getVersionManagerStatus(LOCAL, 'volta')).toBeNull();
    expect(local.runtimeCalls).toBe(0);
  });

  it('resolves fnm now that this release detects it too', async () => {
    const local = fakeClient();
    const service = serviceFor(() => local);

    expect(await service.getVersionManagerStatus(LOCAL, 'fnm')).toMatchObject({ id: 'fnm' });
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

describe('platform-aware runtime ids', () => {
  it('omits winget on a non-Windows target', async () => {
    const local = fakeClient('v1', 'linux');
    const service = serviceFor(() => local);

    await service.listRuntimeStatuses(LOCAL);

    expect(local.lastRuntimeIds).toEqual(['bun', 'node', 'fnm', 'git']);
  });

  it('asks for winget on a Windows target, and enriches the full scan with a prerequisite-missing finding', async () => {
    const remote = fakeClient('v1', 'win32');
    const service = serviceFor(() => remote);

    const statuses = await service.listRuntimeStatuses(WSL);

    expect(remote.lastRuntimeIds).toEqual(['bun', 'node', 'fnm', 'winget', 'git']);

    // fnm's only install recipe on win32 requires winget, and this fixture
    // reports winget as not installed with no recipe of its own to fix
    // that — the exact shape `computePrerequisiteMissingFindings` reports.
    const fnm = statuses.find((status) => status.id === 'fnm');
    expect(fnm?.findings).toContainEqual({
      code: 'prerequisite-missing',
      params: {
        recipe: 'fnm.install',
        requirement: 'winget',
        remedy: expect.stringContaining('apps.microsoft.com'),
      },
      severity: 'warn',
    });
  });
});

describe('forced-probe admission', () => {
  it('joins a forced probe already running for the same key', async () => {
    const local = fakeClient();
    local.holdRuntime = true;
    let clock = 1_000;
    const service = serviceFor(
      () => local,
      () => clock
    );

    const first = service.listRuntimeStatuses(LOCAL, { force: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(local.runtimeCalls).toBe(1);

    // Time passing does not start a second walk; the in-flight scan is
    // the freshness bound until resetCache drops it.
    clock += 500;
    const second = service.listRuntimeStatuses(LOCAL, { force: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(local.runtimeCalls).toBe(1);

    local.settleRuntime();
    await Promise.all([first, second]);
  });

  it('starts a new forced probe after resetCache drops the in-flight scan', async () => {
    let clock = 1_000;
    const callVersions: string[] = [];
    let currentVersion = 'missing';
    const resolvers: Array<(value: unknown) => void> = [];

    const client = {
      manifest: MANIFEST,
      runtimeVersion: '2.0.0-remote',
      probing: {
        runtimes: () =>
          new Promise((resolve) => {
            callVersions.push(currentVersion);
            resolvers.push(resolve);
          }),
        versionManagers: () => Promise.reject(new Error('not used in this test')),
        agentClis: () => Promise.reject(new Error('not used in this test')),
      },
    } as unknown as RuntimeClient;

    const service = createEnvironmentProbingService({
      resolveClient: () => Promise.resolve(client),
      loadReleaseMetadata: () => Promise.resolve(null),
      getSelfVersion: () => '9.9.9',
      now: () => clock,
    });

    // A stale scan is already running — e.g. a poll that began before install.
    const stale = service.listRuntimeStatuses(LOCAL, { force: true });
    await Promise.resolve();
    await Promise.resolve();

    // Install completion resets the cache, then the post-install force fires.
    currentVersion = 'installed';
    clock += 500;
    service.resetCache(LOCAL.environmentId);
    const afterInstall = service.listRuntimeStatuses(LOCAL, { force: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(resolvers).toHaveLength(2);
    // Every requested id needs an entry, or the later lazy read below finds
    // one uncached and starts a third scan nothing here ever resolves.
    const otherRuntimeStatuses = [
      { id: 'fnm', health: 'missing', installations: [], findings: [] },
      { id: 'winget', health: 'missing', installations: [], findings: [] },
      { id: 'git', health: 'missing', installations: [], findings: [] },
    ];
    // `installations` non-empty so the prerequisite-findings pass, which
    // reads every status in the batch, sees a real "installed" shape.
    const installedEntry = (id: string, version: string) => ({
      id,
      effective: { version },
      installations: [
        { path: `/${id}`, rawPath: `/${id}`, version, origin: 'path', effective: true },
      ],
      findings: [],
    });
    resolvers[0]?.({
      statuses: [
        installedEntry('bun', callVersions[0] as string),
        installedEntry('node', callVersions[0] as string),
        ...otherRuntimeStatuses,
      ],
    });
    resolvers[1]?.({
      statuses: [
        installedEntry('bun', callVersions[1] as string),
        installedEntry('node', callVersions[1] as string),
        ...otherRuntimeStatuses,
      ],
    });

    const [, afterInstallResult] = await Promise.all([stale, afterInstall]);
    expect(afterInstallResult[0]?.effective?.version).toBe('installed');

    // The pre-reset completion must not overwrite the post-install cache.
    const cached = await service.listRuntimeStatuses(LOCAL);
    expect(cached[0]?.effective?.version).toBe('installed');
    expect(callVersions).toEqual(['missing', 'installed']);
  });

  it('collapses forced probes inside the minimum interval into one scan', async () => {
    const local = fakeClient();
    let clock = 1_000;
    const service = serviceFor(
      () => local,
      () => clock
    );

    await service.listRuntimeStatuses(LOCAL, { force: true });
    expect(local.runtimeCalls).toBe(1);

    clock += 200;
    await service.listRuntimeStatuses(LOCAL, { force: true });
    clock += 200;
    await service.listRuntimeStatuses(LOCAL, { force: true });
    expect(local.runtimeCalls).toBe(1);

    // Past the minimum interval: a repeated force scans again.
    clock += 1_000;
    await service.listRuntimeStatuses(LOCAL, { force: true });
    expect(local.runtimeCalls).toBe(2);
  });

  it('does not reuse a forced completion produced by a previous connection', async () => {
    let current = fakeClient('v1');
    let clock = 1_000;
    const service = serviceFor(
      () => current,
      () => clock
    );

    await service.listRuntimeStatuses(LOCAL, { force: true });
    expect(current.runtimeCalls).toBe(1);

    current = fakeClient('v2');
    clock += 200;
    const afterReconnect = await service.listRuntimeStatuses(LOCAL, { force: true });

    expect(afterReconnect[0]?.effective?.version).toBe('v2');
    expect(current.runtimeCalls).toBe(1);
  });

  it('lets an in-flight probe for another environment land after a scoped reset', async () => {
    const clients = new Map([
      [LOCAL.environmentId, fakeClient()],
      [WSL.environmentId, fakeClient()],
    ]);
    const wsl = clients.get(WSL.environmentId) as FakeClient;
    wsl.holdRuntime = true;
    const service = serviceFor((scope) => clients.get(scope.environmentId) as FakeClient);

    const inflightWsl = service.listRuntimeStatuses(WSL);
    await Promise.resolve();
    await Promise.resolve();
    expect(wsl.runtimeCalls).toBe(1);

    service.resetCache(LOCAL.environmentId);
    wsl.settleRuntime();
    await inflightWsl;

    await service.listRuntimeStatuses(WSL);
    expect(wsl.runtimeCalls).toBe(1);
  });
});

describe('the shared location cache', () => {
  it('answers two consumers from one probe, and force refreshes both', async () => {
    const local = fakeClient();
    const service = serviceFor(() => local);

    const first = await service.listLocationStatuses(LOCAL);
    const second = await service.listLocationStatuses(LOCAL);
    expect(local.locationCalls).toBe(1);
    expect(first).toEqual(second);

    await service.listLocationStatuses(LOCAL, { force: true });
    expect(local.locationCalls).toBe(2);
  });

  it('drops only the location answers on a location-scoped reset', async () => {
    const local = fakeClient();
    const service = serviceFor(() => local);

    await service.listRuntimeStatuses(LOCAL);
    await service.listLocationStatuses(LOCAL);
    expect(local.runtimeCalls).toBe(1);
    expect(local.locationCalls).toBe(1);

    service.resetLocationCache(LOCAL.environmentId);

    await service.listLocationStatuses(LOCAL);
    expect(local.locationCalls).toBe(2);
    // A library write says nothing about which toolchains are installed.
    await service.listRuntimeStatuses(LOCAL);
    expect(local.runtimeCalls).toBe(1);
  });

  it('does not let a slow agent probe overwrite a newer location scan', async () => {
    const local = fakeClient();
    local.holdAgent = true;
    local.locationEntryCount = 1;
    const service = serviceFor(() => local);

    // Agent scan starts first and hangs holding its own pre-change snapshot.
    const agents = service.listAgentCliStatuses(LOCAL);
    await Promise.resolve();
    await Promise.resolve();
    expect(local.agentCalls).toBe(1);

    // A location scan started later is the newer answer and must win.
    local.locationEntryCount = 2;
    await service.listLocationStatuses(LOCAL);
    expect(local.locationCalls).toBe(1);

    local.settleAgent();
    await agents;

    const after = await service.listLocationStatuses(LOCAL);
    expect(local.locationCalls).toBe(1);
    expect(after.map((location) => location.entryCount)).toEqual(after.map(() => 2));
  });

  it('reuses agent location results instead of walking the filesystem again', async () => {
    const local = fakeClient();
    const service = serviceFor(() => local);

    await service.listAgentCliStatuses(LOCAL);
    expect(local.agentCalls).toBe(1);
    expect(local.locationCalls).toBe(0);

    const locations = await service.listLocationStatuses(LOCAL);
    expect(local.locationCalls).toBe(0);
    expect(locations.map((location) => location.id)).toEqual(
      LIBRARY_LOCATION_DEFINITIONS.map((definition) => definition.id)
    );

    await service.listAgentCliStatuses(LOCAL, { force: true });
    expect(local.agentCalls).toBe(2);
    const refreshed = await service.listLocationStatuses(LOCAL);
    expect(local.locationCalls).toBe(0);
    expect(refreshed).toEqual(locations);
  });

  it('refuses a machine that does not advertise library discovery', async () => {
    const client = {
      manifest: { platform: 'linux', features: { library: false } } as RuntimeCapabilityManifest,
      library: {
        locations: () => Promise.reject(new Error('should not be reached')),
      },
    } as unknown as RuntimeClient;
    const service = createEnvironmentProbingService({
      resolveClient: () => Promise.resolve(client),
      loadReleaseMetadata: () => Promise.resolve(null),
      getSelfVersion: () => '9.9.9',
      now: () => 1_000,
    });

    // The guard belongs to the scan, not to its caller: `EnvironmentLibraryService`
    // used to resolve the connection a second time to check this, so a reconnect
    // between the two could leave it checking a manifest that did not answer the
    // request.
    await expect(service.listLocationStatuses(LOCAL)).rejects.toBeInstanceOf(
      LibraryFeatureUnavailableError
    );
  });
});
