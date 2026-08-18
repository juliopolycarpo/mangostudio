/**
 * Toolchain, version-manager and agent-CLI status per environment.
 *
 * The looking happens on the runtime; what stays here is everything that is a
 * hub decision — which recipes exist, which Node releases are current, how long
 * an answer may be reused, and who is allowed to ask. Cache entries are keyed
 * by environment *and* by the connection that produced them: a runtime that
 * reconnected is a machine that may have changed underneath, so its entries are
 * dropped rather than carried across the gap.
 */

import { dirname, join } from 'node:path';
import type {
  AgentCliStatus,
  RuntimeId,
  RuntimeStatus,
  VersionManagerId,
  VersionManagerStatus,
} from '@mangostudio/shared/environments';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import {
  AGENT_CLI_DEFINITIONS,
  NODE_RELEASE_LIVE_DATA_STALE_AFTER_MS,
} from '@mangostudio/shared/environments/detection';
import type { LibraryLocationStatus, LibraryTargetId } from '@mangostudio/shared/library';
import { LIBRARY_LOCATION_DEFINITIONS } from '@mangostudio/shared/library/host';
import { getConfig, getHomeMangoDir, getVersion } from '../../../lib/config';
import type { RuntimeClient } from '../../../services/runtime-client/runtime-client';
import { getRuntimeClient } from '../../../services/runtime-client/runtime-connection-manager';
import { LibraryFeatureUnavailableError } from '../../library/domain/library-feature-error';
import { hubLibraryEnvFor } from '../../library/infrastructure/location-probe';
import { hasInstallRecipeForRuntime } from '../domain/install-recipes';
import {
  loadNodeReleaseMetadata,
  type NodeReleaseMetadata,
} from '../infrastructure/node-release-cache';

const DEFAULT_CACHE_TTL_MS = 30_000;
const NODE_RELEASE_CACHE_FILE = 'node-releases.json';

/**
 * After a forced probe completes, another force for the same (scope, kind,
 * ids) reuses that result instead of starting a new scan. A stuck re-check
 * button then costs one scan per second, not per click. An in-flight forced
 * scan is joined first, so this window never answers a caller with a
 * completed result while a newer scan is still running.
 */
const FORCED_PROBE_MIN_INTERVAL_MS = 1_000;

/**
 * Probe spawns on a remote machine are slower than local ones, so the budget
 * the runtime enforces is generous — and the hub's own deadline sits above it,
 * because an unset `timeoutMs` leaves a hung remote hanging the request forever.
 */
const PROBE_BUDGET = { probeTimeoutMs: 2_000, totalTimeoutMs: 5_000 } as const;
const PROBE_REQUEST_TIMEOUT_MS = 15_000;
/**
 * A location walk stats and counts every registered directory, so it is bound
 * by the machine's filesystem rather than by a spawn budget. This is the
 * deadline `EnvironmentLibraryService` enforced before the two caches merged;
 * dropping it to the spawn-shaped `PROBE_REQUEST_TIMEOUT_MS` would fail slow
 * remote machines that used to answer.
 */
const LOCATION_REQUEST_TIMEOUT_MS = 60_000;

const RUNTIME_IDS: readonly RuntimeId[] = ['bun', 'node'];
const VERSION_MANAGER_IDS: readonly VersionManagerId[] = ['nvm'];
const AGENT_TARGET_IDS: readonly LibraryTargetId[] = AGENT_CLI_DEFINITIONS.map(
  (definition) => definition.targetId
);
const LIBRARY_LOCATION_IDS = LIBRARY_LOCATION_DEFINITIONS.map((definition) => definition.id);

export interface ProbeScope {
  readonly userId: string;
  readonly environmentId: string;
}

export interface ProbeOptions {
  readonly force?: boolean;
}

/**
 * The hub's own machine, for callers that have no user session to speak of —
 * the CLI, and the settings defaults derived at first boot. `local` resolves to
 * the in-process runtime whatever user id is attached to it.
 */
export const LOCAL_PROBE_SCOPE: ProbeScope = {
  userId: 'local',
  environmentId: LOCAL_ENVIRONMENT_ID,
};

export interface EnvironmentProbingService {
  listRuntimeStatuses(scope: ProbeScope, options?: ProbeOptions): Promise<RuntimeStatus[]>;
  getRuntimeStatus(
    scope: ProbeScope,
    id: RuntimeId,
    options?: ProbeOptions
  ): Promise<RuntimeStatus | null>;
  listVersionManagerStatuses(
    scope: ProbeScope,
    options?: ProbeOptions
  ): Promise<VersionManagerStatus[]>;
  getVersionManagerStatus(
    scope: ProbeScope,
    id: VersionManagerId,
    options?: ProbeOptions
  ): Promise<VersionManagerStatus | null>;
  listAgentCliStatuses(scope: ProbeScope, options?: ProbeOptions): Promise<AgentCliStatus[]>;
  getAgentCliStatus(
    scope: ProbeScope,
    targetId: LibraryTargetId,
    options?: ProbeOptions
  ): Promise<AgentCliStatus | null>;
  /**
   * Every library location the agent-CLI targets read, in one probe. Shared
   * with the agent-CLI cache so the Environments panel and the Library matrix
   * never walk the same paths twice for the same answer.
   */
  listLocationStatuses(scope: ProbeScope, options?: ProbeOptions): Promise<LibraryLocationStatus[]>;
  /** Drops cached answers; without an environment, for every one of them. */
  resetCache(environmentId?: string): void;
  /**
   * Drops only the location answers. A library write changes what the
   * locations look like and nothing about which toolchains are installed, so
   * it must not discard — nor cancel the write of — an in-flight runtime,
   * version-manager or agent-CLI scan.
   */
  resetLocationCache(environmentId?: string): void;
}

type ProbeKind = 'runtime' | 'version-manager' | 'agent' | 'location';

interface CacheEntry<T> {
  readonly checkedAt: number;
  /** The connection that answered. A different one means a different process. */
  readonly client: RuntimeClient;
  readonly status: T;
  readonly environmentId: string;
}

type AnyStatus = RuntimeStatus | VersionManagerStatus | AgentCliStatus | LibraryLocationStatus;

interface ForcedCompletion {
  readonly completedAt: number;
  readonly statuses: readonly AnyStatus[];
  /** Same identity `readFresh` uses: a reconnect is a different machine. */
  readonly client: RuntimeClient;
}

interface InflightScan {
  readonly client: RuntimeClient;
  readonly promise: Promise<readonly AnyStatus[]>;
}

export interface EnvironmentProbingServiceOptions {
  readonly resolveClient?: (scope: ProbeScope) => Promise<RuntimeClient>;
  readonly loadReleaseMetadata?: (force: boolean) => Promise<NodeReleaseMetadata | null>;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
  readonly getSelfVersion?: () => string;
}

function loadDefaultReleaseMetadata(force: boolean): Promise<NodeReleaseMetadata | null> {
  const config = getConfig();
  return loadNodeReleaseMetadata({
    enabled: config.environments.ltsRefresh,
    cacheFile: join(getHomeMangoDir(), 'cache', NODE_RELEASE_CACHE_FILE),
    force,
  });
}

function isUsableLiveMetadata(metadata: NodeReleaseMetadata | null, now: number): boolean {
  if (!metadata) return false;
  const age = now - metadata.fetchedAtMs;
  return age >= 0 && age <= NODE_RELEASE_LIVE_DATA_STALE_AFTER_MS;
}

/**
 * `LibraryTargetId` is a subset of `RuntimeId`, so agent targets and runtimes
 * both answer the recipe registry directly — the constraint is what keeps this
 * cast-free while still serving both lists.
 */
function installableFor<Id extends RuntimeId>(
  ids: readonly Id[],
  platform: string
): Record<string, boolean> {
  const installable: Record<string, boolean> = {};
  for (const id of ids) installable[id] = hasInstallRecipeForRuntime(id, platform);
  return installable;
}

export function createEnvironmentProbingService(
  options: EnvironmentProbingServiceOptions = {}
): EnvironmentProbingService {
  const resolveClient =
    options.resolveClient ?? ((scope) => getRuntimeClient(scope.userId, scope.environmentId));
  const loadReleaseMetadata = options.loadReleaseMetadata ?? loadDefaultReleaseMetadata;
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const getSelfVersion = options.getSelfVersion ?? getVersion;
  const cache = new Map<string, CacheEntry<AnyStatus>>();
  const inflight = new Map<string, InflightScan>();
  /** Newest generation per scoped probe may write cache; older ones must not. */
  const generations = new Map<string, number>();
  /** Last result a forced probe produced, keyed the same as `generations`. */
  const forcedCompletions = new Map<string, ForcedCompletion>();
  // A full reset bumps the global epoch; a per-environment reset bumps only
  // that environment so an in-flight scan elsewhere can still land.
  let globalResetEpoch = 0;
  const envResetEpochs = new Map<string, number>();

  // Environments are per-user rows, so two users can own the same id. The user
  // is part of the key for the same reason the connection is: neither of them
  // describes the same machine. Unit separator keeps ids that contain spaces
  // from colliding when resetCache filters by environment.
  const SCOPE_SEP = '\u001f';
  const scopeKey = (scope: ProbeScope) => `${scope.userId}${SCOPE_SEP}${scope.environmentId}`;
  const entryKey = (scope: ProbeScope, kind: ProbeKind, id: string) =>
    `${scopeKey(scope)}${SCOPE_SEP}${kind}${SCOPE_SEP}${id}`;
  // Every by-key map shares the `userId SEP environmentId SEP kind SEP …`
  // layout, so field 1 is the environment and field 2 is the probe kind.
  const environmentOf = (key: string) => key.split(SCOPE_SEP)[1];
  const kindOf = (key: string) => key.split(SCOPE_SEP)[2];
  /** Drops every entry a `scopeKey`-prefixed map holds for one environment. */
  const dropScopedTo = <V>(entries: Map<string, V>, environmentId: string): void => {
    for (const key of [...entries.keys()]) {
      if (environmentOf(key) === environmentId) entries.delete(key);
    }
  };

  const readFresh = <T extends AnyStatus>(
    scope: ProbeScope,
    kind: ProbeKind,
    ids: readonly string[],
    client: RuntimeClient
  ): T[] | null => {
    const currentTime = now();
    const statuses: T[] = [];
    for (const id of ids) {
      const entry = cache.get(entryKey(scope, kind, id));
      if (!entry || entry.client !== client || currentTime - entry.checkedAt >= cacheTtlMs) {
        return null;
      }
      statuses.push(entry.status as T);
    }
    return statuses;
  };

  const writeStatuses = (
    scope: ProbeScope,
    kind: ProbeKind,
    client: RuntimeClient,
    statuses: readonly AnyStatus[],
    idOf: (status: AnyStatus) => string
  ): void => {
    const checkedAt = now();
    for (const status of statuses) {
      cache.set(entryKey(scope, kind, idOf(status)), {
        checkedAt,
        client,
        status,
        environmentId: scope.environmentId,
      });
    }
  };

  /**
   * The hub's own machine is the one place its configured library directories
   * and its own executable are the truth. Anywhere else those paths name
   * nothing, so the runtime answers from its own environment instead.
   */
  const isHubMachine = (environmentId: string) => environmentId === LOCAL_ENVIRONMENT_ID;

  /** Spreadable: the hub's configured PATH, and nothing at all anywhere else. */
  const pathEnvFor = (environmentId: string) => {
    const env = hubLibraryEnvFor(environmentId);
    return env ? { pathEnv: { env } } : {};
  };

  /**
   * A completion is only readable for `FORCED_PROBE_MIN_INTERVAL_MS`, so every
   * older one is dead weight. Sweeping on write keeps the map to the handful
   * of keys forced within that window instead of one entry per (user,
   * environment, kind, ids) combination ever probed, for the life of the hub.
   */
  const recordForcedCompletion = (
    key: string,
    statuses: readonly AnyStatus[],
    client: RuntimeClient
  ): void => {
    const completedAt = now();
    for (const [existing, entry] of forcedCompletions) {
      if (completedAt - entry.completedAt >= FORCED_PROBE_MIN_INTERVAL_MS) {
        forcedCompletions.delete(existing);
      }
    }
    forcedCompletions.set(key, { completedAt, statuses, client });
  };

  /**
   * The Library matrix and the agent-CLI panel describe the same paths.
   * Union every agent's locations and, when that covers the full registry,
   * reuse it so `listLocationStatuses` does not walk the filesystem again.
   */
  const completeLocationsFrom = (
    statuses: readonly AnyStatus[]
  ): LibraryLocationStatus[] | null => {
    const byId = new Map<string, LibraryLocationStatus>();
    for (const status of statuses) {
      if (!('locations' in status) || !Array.isArray(status.locations)) continue;
      for (const location of status.locations) {
        byId.set(location.id, location);
      }
    }
    const locations: LibraryLocationStatus[] = [];
    for (const id of LIBRARY_LOCATION_IDS) {
      const location = byId.get(id);
      if (!location) return null;
      locations.push(location);
    }
    return locations;
  };

  const locationProbeKey = (scope: ProbeScope) =>
    `${scopeKey(scope)}${SCOPE_SEP}location${SCOPE_SEP}${[...LIBRARY_LOCATION_IDS].sort().join(',')}`;

  /**
   * Only a scan covering every agent target can union the whole registry, so
   * only that scan claims the location key. A single-target re-check reserves
   * nothing, and so cannot cancel a location scan it could never have seeded.
   */
  const seedsLocations = (kind: ProbeKind, ids: readonly string[]): boolean =>
    kind === 'agent' && AGENT_TARGET_IDS.every((targetId) => ids.includes(targetId));

  const seedLocationCache = (
    scope: ProbeScope,
    client: RuntimeClient,
    statuses: readonly AnyStatus[],
    force: boolean
  ): void => {
    const locations = completeLocationsFrom(statuses);
    if (!locations) return;
    writeStatuses(
      scope,
      'location',
      client,
      locations,
      (status) => (status as LibraryLocationStatus).id
    );
    if (force) recordForcedCompletion(locationProbeKey(scope), locations, client);
  };

  const probe = async <T extends AnyStatus>(
    scope: ProbeScope,
    kind: ProbeKind,
    ids: readonly string[],
    idOf: (status: AnyStatus) => string,
    force: boolean,
    run: (client: RuntimeClient) => Promise<readonly AnyStatus[]>
  ): Promise<T[]> => {
    // Captured before `resolveClient` so the minimum-interval window is the
    // time since this request arrived, not since the connection resolved.
    const requestArrivedAt = now();
    const client = await resolveClient(scope);
    if (!force) {
      const cached = readFresh<T>(scope, kind, ids, client);
      if (cached) return cached;
    }

    const key = `${scopeKey(scope)}${SCOPE_SEP}${kind}${SCOPE_SEP}${[...ids].sort().join(',')}`;
    // A forced probe never joins a lazy one — that is the whole point of asking
    // again — but a lazy caller happily rides the forced probe already running.
    const forcedKey = `${key}${SCOPE_SEP}force`;

    const sameClient = (scan: InflightScan | undefined) => scan?.client === client;

    if (force) {
      // Join the scan already running for this key. A mutation that must not
      // be observed as pre-change state calls resetCache, which drops inflight
      // so the next force starts a new walk instead of riding the stale one.
      const running = inflight.get(forcedKey);
      if (running && sameClient(running)) return (await running.promise) as T[];

      // No scan is running: the minimum interval decides whether this request
      // gets the last forced answer or a new one. Ordered after the join so a
      // caller that arrives while a scan is in flight rides that scan rather
      // than a completed result from before it started. Reuse also requires
      // the same connection `readFresh` would demand.
      const lastForced = forcedCompletions.get(key);
      if (
        lastForced &&
        lastForced.client === client &&
        requestArrivedAt - lastForced.completedAt < FORCED_PROBE_MIN_INTERVAL_MS
      ) {
        return lastForced.statuses as T[];
      }
    } else {
      // Each candidate is tested on its own: a forced scan left behind by a
      // previous connection must not hide the lazy scan running on this one.
      const running = inflight.get(forcedKey);
      const pending = sameClient(running) ? running : inflight.get(key);
      if (pending && sameClient(pending)) return (await pending.promise) as T[];
    }

    const inflightKey = force ? forcedKey : key;
    // Forced vs lazy races: only the newest generation for this scoped probe
    // may land in the cache. An older completion still answers its caller.
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    // An agent scan over every target seeds the location cache from its own
    // answer, so it reserves the location key's generation here for exactly
    // the same reason: a slow agent probe must not overwrite the locations a
    // scan that started later already wrote.
    const locationKey = seedsLocations(kind, ids) ? locationProbeKey(scope) : null;
    const locationGeneration = locationKey ? (generations.get(locationKey) ?? 0) + 1 : 0;
    if (locationKey) generations.set(locationKey, locationGeneration);
    const epochAtStart = {
      global: globalResetEpoch,
      env: envResetEpochs.get(scope.environmentId) ?? 0,
    };
    const promise: Promise<readonly AnyStatus[]> = run(client)
      .then((statuses) => {
        if (
          generations.get(key) === generation &&
          globalResetEpoch === epochAtStart.global &&
          (envResetEpochs.get(scope.environmentId) ?? 0) === epochAtStart.env
        ) {
          writeStatuses(scope, kind, client, statuses, idOf);
          if (force) recordForcedCompletion(key, statuses, client);
          if (locationKey && generations.get(locationKey) === locationGeneration) {
            seedLocationCache(scope, client, statuses, force);
          }
        }
        return statuses;
      })
      .finally(() => {
        if (inflight.get(inflightKey)?.promise === promise) inflight.delete(inflightKey);
      });
    inflight.set(inflightKey, { client, promise });
    return (await promise) as T[];
  };

  const probeRuntimes = (
    scope: ProbeScope,
    ids: readonly RuntimeId[],
    force: boolean
  ): Promise<RuntimeStatus[]> =>
    probe<RuntimeStatus>(
      scope,
      'runtime',
      ids,
      (status) => (status as RuntimeStatus).id,
      force,
      async (client) => {
        const result = await client.probing.runtimes(
          {
            ids,
            installable: installableFor(ids, client.manifest.platform),
            budget: PROBE_BUDGET,
            ...pathEnvFor(scope.environmentId),
          },
          { timeoutMs: PROBE_REQUEST_TIMEOUT_MS }
        );
        return result.statuses;
      }
    );

  const probeVersionManagers = (
    scope: ProbeScope,
    ids: readonly VersionManagerId[],
    force: boolean
  ): Promise<VersionManagerStatus[]> =>
    probe<VersionManagerStatus>(
      scope,
      'version-manager',
      ids,
      (status) => (status as VersionManagerStatus).id,
      force,
      async (client) => {
        const metadata = await loadReleaseMetadata(force);
        const live = isUsableLiveMetadata(metadata, now()) ? metadata : null;
        const result = await client.probing.versionManagers(
          {
            ids,
            budget: PROBE_BUDGET,
            ...(live && {
              latestByMajor: Object.fromEntries(
                [...live.latestByMajor].map(([major, version]) => [String(major), version])
              ),
            }),
            ...pathEnvFor(scope.environmentId),
          },
          { timeoutMs: PROBE_REQUEST_TIMEOUT_MS }
        );
        return result.statuses;
      }
    );

  const probeAgentClis = (
    scope: ProbeScope,
    targetIds: readonly LibraryTargetId[],
    force: boolean
  ): Promise<AgentCliStatus[]> =>
    probe<AgentCliStatus>(
      scope,
      'agent',
      targetIds,
      (status) => (status as AgentCliStatus).targetId,
      force,
      async (client) => {
        const local = isHubMachine(scope.environmentId);
        const result = await client.probing.agentClis(
          {
            targetIds,
            installable: installableFor(targetIds, client.manifest.platform),
            budget: PROBE_BUDGET,
            self: {
              // Remote mangostudio is whatever that runtime handshaked as —
              // the hub's own release is the wrong answer for another machine.
              version: local ? getSelfVersion() : client.runtimeVersion,
              ...(local && {
                configHome: dirname(getConfig().configFilePath),
                executablePath: process.execPath,
              }),
            },
            ...pathEnvFor(scope.environmentId),
          },
          { timeoutMs: PROBE_REQUEST_TIMEOUT_MS }
        );
        return result.statuses;
      }
    );

  const probeLocations = (scope: ProbeScope, force: boolean): Promise<LibraryLocationStatus[]> =>
    probe<LibraryLocationStatus>(
      scope,
      'location',
      LIBRARY_LOCATION_IDS,
      (status) => (status as LibraryLocationStatus).id,
      force,
      async (client) => {
        // Guarded here rather than at the caller: `probe` resolves the
        // connection this scan actually runs on, and the consent gate would
        // otherwise answer a machine without the feature with a raw RPC
        // refusal instead of the 503 `handleLibraryError` renders.
        if (!client.manifest.features.library) {
          throw new LibraryFeatureUnavailableError(
            `Environment "${scope.environmentId}" does not advertise library discovery.`
          );
        }
        const result = await client.library.locations(
          { ...pathEnvFor(scope.environmentId) },
          { timeoutMs: LOCATION_REQUEST_TIMEOUT_MS }
        );
        return result.locations;
      }
    );

  return {
    listRuntimeStatuses: (scope, probeOptions) =>
      probeRuntimes(scope, RUNTIME_IDS, probeOptions?.force === true),

    async getRuntimeStatus(scope, id, probeOptions) {
      if (!RUNTIME_IDS.includes(id)) return null;
      const [status] = await probeRuntimes(scope, [id], probeOptions?.force === true);
      return status ?? null;
    },

    listVersionManagerStatuses: (scope, probeOptions) =>
      probeVersionManagers(scope, VERSION_MANAGER_IDS, probeOptions?.force === true),

    async getVersionManagerStatus(scope, id, probeOptions) {
      if (!VERSION_MANAGER_IDS.includes(id)) return null;
      const [status] = await probeVersionManagers(scope, [id], probeOptions?.force === true);
      return status ?? null;
    },

    listAgentCliStatuses: (scope, probeOptions) =>
      probeAgentClis(scope, AGENT_TARGET_IDS, probeOptions?.force === true),

    async getAgentCliStatus(scope, targetId, probeOptions) {
      if (!AGENT_TARGET_IDS.includes(targetId)) return null;
      const [status] = await probeAgentClis(scope, [targetId], probeOptions?.force === true);
      return status ?? null;
    },

    listLocationStatuses: (scope, probeOptions) =>
      probeLocations(scope, probeOptions?.force === true),

    resetCache(environmentId) {
      if (!environmentId) {
        globalResetEpoch += 1;
        envResetEpochs.clear();
        cache.clear();
        inflight.clear();
        generations.clear();
        forcedCompletions.clear();
        return;
      }
      envResetEpochs.set(environmentId, (envResetEpochs.get(environmentId) ?? 0) + 1);
      for (const [key, entry] of [...cache.entries()]) {
        if (entry.environmentId === environmentId) cache.delete(key);
      }
      // scopeKey is userId SEP environmentId SEP … — environment is field 1.
      dropScopedTo(inflight, environmentId);
      dropScopedTo(generations, environmentId);
      dropScopedTo(forcedCompletions, environmentId);
    },

    resetLocationCache(environmentId) {
      const matches = (key: string) =>
        kindOf(key) === 'location' &&
        (environmentId === undefined || environmentOf(key) === environmentId);
      for (const key of [...cache.keys()]) {
        if (matches(key)) cache.delete(key);
      }
      for (const key of [...inflight.keys()]) {
        if (matches(key)) inflight.delete(key);
      }
      for (const key of [...forcedCompletions.keys()]) {
        if (matches(key)) forcedCompletions.delete(key);
      }
      // Bumped rather than dropped, which is what the reset epochs exist for
      // on the whole-environment path: an in-flight location scan — or an
      // agent scan holding a reservation to seed from its own locations — must
      // not write the pre-change answer after this returns.
      for (const [key, generation] of generations) {
        if (matches(key)) generations.set(key, generation + 1);
      }
    },
  };
}

export const environmentProbingService = createEnvironmentProbingService();
