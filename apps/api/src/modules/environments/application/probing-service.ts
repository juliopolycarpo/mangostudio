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
import type { LibraryTargetId } from '@mangostudio/shared/library';
import { getConfig, getHomeMangoDir, getVersion } from '../../../lib/config';
import type { RuntimeClient } from '../../../services/runtime-client/runtime-client';
import { getRuntimeClient } from '../../../services/runtime-client/runtime-connection-manager';
import { configuredLibraryEnv } from '../../library/infrastructure/location-probe';
import { hasInstallRecipeForRuntime } from '../domain/install-recipes';
import {
  loadNodeReleaseMetadata,
  type NodeReleaseMetadata,
} from '../infrastructure/node-release-cache';

const DEFAULT_CACHE_TTL_MS = 30_000;
const NODE_RELEASE_CACHE_FILE = 'node-releases.json';

/**
 * Probe spawns on a remote machine are slower than local ones, so the budget
 * the runtime enforces is generous — and the hub's own deadline sits above it,
 * because an unset `timeoutMs` leaves a hung remote hanging the request forever.
 */
const PROBE_BUDGET = { probeTimeoutMs: 2_000, totalTimeoutMs: 5_000 } as const;
const PROBE_REQUEST_TIMEOUT_MS = 15_000;

const RUNTIME_IDS: readonly RuntimeId[] = ['bun', 'node'];
const VERSION_MANAGER_IDS: readonly VersionManagerId[] = ['nvm'];
const AGENT_TARGET_IDS: readonly LibraryTargetId[] = AGENT_CLI_DEFINITIONS.map(
  (definition) => definition.targetId
);

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
  /** Drops cached answers; without an environment, for every one of them. */
  resetCache(environmentId?: string): void;
}

type ProbeKind = 'runtime' | 'version-manager' | 'agent';

interface CacheEntry<T> {
  readonly checkedAt: number;
  /** The connection that answered. A different one means a different process. */
  readonly client: RuntimeClient;
  readonly status: T;
}

type AnyStatus = RuntimeStatus | VersionManagerStatus | AgentCliStatus;

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

function installableFor<Id extends string>(
  ids: readonly Id[],
  platform: string
): Record<string, boolean> {
  const installable: Record<string, boolean> = {};
  for (const id of ids) installable[id] = hasInstallRecipeForRuntime(id as RuntimeId, platform);
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
  const inflight = new Map<string, Promise<readonly AnyStatus[]>>();

  // Environments are per-user rows, so two users can own the same id. The user
  // is part of the key for the same reason the connection is: neither of them
  // describes the same machine.
  const scopeKey = (scope: ProbeScope) => `${scope.userId} ${scope.environmentId}`;
  const entryKey = (scope: ProbeScope, kind: ProbeKind, id: string) =>
    `${scopeKey(scope)} ${kind} ${id}`;

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
      cache.set(entryKey(scope, kind, idOf(status)), { checkedAt, client, status });
    }
  };

  /**
   * The hub's own machine is the one place its configured library directories
   * and its own executable are the truth. Anywhere else those paths name
   * nothing, so the runtime answers from its own environment instead.
   */
  const isHubMachine = (environmentId: string) => environmentId === LOCAL_ENVIRONMENT_ID;

  const probe = async <T extends AnyStatus>(
    scope: ProbeScope,
    kind: ProbeKind,
    ids: readonly string[],
    idOf: (status: AnyStatus) => string,
    force: boolean,
    run: (client: RuntimeClient) => Promise<readonly AnyStatus[]>
  ): Promise<T[]> => {
    const client = await resolveClient(scope);
    if (!force) {
      const cached = readFresh<T>(scope, kind, ids, client);
      if (cached) return cached;
    }

    const key = `${scopeKey(scope)} ${kind} ${[...ids].sort().join(',')}`;
    // A forced probe never joins a lazy one — that is the whole point of asking
    // again — but a lazy caller happily rides the forced probe already running.
    const forcedKey = `${key} force`;
    const pending = force
      ? inflight.get(forcedKey)
      : (inflight.get(forcedKey) ?? inflight.get(key));
    if (pending) return (await pending) as T[];

    const inflightKey = force ? forcedKey : key;
    const probing = run(client)
      .then((statuses) => {
        writeStatuses(scope, kind, client, statuses, idOf);
        return statuses;
      })
      .finally(() => {
        if (inflight.get(inflightKey) === probing) inflight.delete(inflightKey);
      });
    inflight.set(inflightKey, probing);
    return (await probing) as T[];
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
            ...(isHubMachine(scope.environmentId) && { pathEnv: { env: configuredLibraryEnv() } }),
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
            ...(isHubMachine(scope.environmentId) && { pathEnv: { env: configuredLibraryEnv() } }),
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
              version: getSelfVersion(),
              ...(local && {
                configHome: dirname(getConfig().configFilePath),
                executablePath: process.execPath,
              }),
            },
            ...(local && { pathEnv: { env: configuredLibraryEnv() } }),
          },
          { timeoutMs: PROBE_REQUEST_TIMEOUT_MS }
        );
        return result.statuses;
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

    resetCache(environmentId) {
      if (!environmentId) {
        cache.clear();
        inflight.clear();
        return;
      }
      const forEnvironment = (key: string) => key.split(' ')[1] === environmentId;
      for (const key of [...cache.keys()]) {
        if (forEnvironment(key)) cache.delete(key);
      }
      for (const key of [...inflight.keys()]) {
        if (forEnvironment(key)) inflight.delete(key);
      }
    },
  };
}

export const environmentProbingService = createEnvironmentProbingService();
