import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { VersionManagerId, VersionManagerStatus } from '@mangostudio/shared/environments';
import { getConfig, getHomeMangoDir } from '../../../lib/config';
import {
  NODE_RELEASE_LIVE_DATA_STALE_AFTER_MS,
  type NodeReleaseSchedule,
} from '../domain/lts-policy';
import { NODE_RELEASE_SCHEDULE } from '../domain/node-release-schedule';
import { createNvmFileSystem, detectNvm, type NvmDetectionDeps } from '../domain/nvm';
import {
  loadNodeReleaseMetadata,
  type NodeReleaseMetadata,
} from '../infrastructure/node-release-cache';
import type { RuntimeDetectionService } from './runtime-detection';
import { runtimeDetectionService } from './runtime-detection';

const DEFAULT_CACHE_TTL_MS = 30_000;
const NODE_RELEASE_CACHE_FILE = 'node-releases.json';

interface VersionManagerCacheEntry {
  readonly checkedAt: number;
  readonly environmentKey: string;
  readonly status: VersionManagerStatus;
}

interface VersionManagerDetectionOptions {
  readonly force?: boolean;
}

export interface VersionManagerDetectionService {
  listVersionManagerStatuses(
    options?: VersionManagerDetectionOptions
  ): Promise<VersionManagerStatus[]>;
  getVersionManagerStatus(
    id: VersionManagerId,
    options?: VersionManagerDetectionOptions
  ): Promise<VersionManagerStatus | null>;
  resetVersionManagerCache(id?: VersionManagerId): void;
}

export interface VersionManagerDetectionServiceOptions {
  readonly createDeps?: () => NvmDetectionDeps;
  readonly runtimeService?: Pick<RuntimeDetectionService, 'getRuntimeStatus'>;
  readonly loadReleaseMetadata?: (force: boolean) => Promise<NodeReleaseMetadata | null>;
  readonly schedule?: NodeReleaseSchedule;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
}

function createDefaultDeps(): NvmDetectionDeps {
  return {
    platform: process.platform,
    homeDir: homedir(),
    env: process.env,
    fs: createNvmFileSystem(),
  };
}

function loadDefaultReleaseMetadata(force: boolean): Promise<NodeReleaseMetadata | null> {
  const config = getConfig();
  return loadNodeReleaseMetadata({
    enabled: config.environments.ltsRefresh,
    cacheFile: join(getHomeMangoDir(), 'cache', NODE_RELEASE_CACHE_FILE),
    force,
  });
}

function environmentKey(deps: NvmDetectionDeps): string {
  return createHash('sha256')
    .update(deps.platform)
    .update('\0')
    .update(deps.homeDir)
    .update('\0')
    .update(deps.env.PATH ?? '')
    .update('\0')
    .update(deps.env.NVM_DIR ?? '')
    .digest('hex');
}

function isUsableLiveMetadata(metadata: NodeReleaseMetadata | null, now: number): boolean {
  if (!metadata) return false;
  const age = now - metadata.fetchedAtMs;
  return age >= 0 && age <= NODE_RELEASE_LIVE_DATA_STALE_AFTER_MS;
}

export function createVersionManagerDetectionService(
  options: VersionManagerDetectionServiceOptions = {}
): VersionManagerDetectionService {
  const createDeps = options.createDeps ?? createDefaultDeps;
  const runtimeService = options.runtimeService ?? runtimeDetectionService;
  const loadReleaseMetadata = options.loadReleaseMetadata ?? loadDefaultReleaseMetadata;
  const schedule = options.schedule ?? NODE_RELEASE_SCHEDULE;
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cache = new Map<VersionManagerId, VersionManagerCacheEntry>();
  const inflight = new Map<string, Promise<VersionManagerStatus>>();
  const probeGenerations = new Map<VersionManagerId, number>();

  const getVersionManagerStatus = (
    id: VersionManagerId,
    detectOptions?: VersionManagerDetectionOptions
  ): Promise<VersionManagerStatus | null> => {
    if (id !== 'nvm') return Promise.resolve(null);

    const deps = createDeps();
    const currentEnvironmentKey = environmentKey(deps);
    const currentTime = now();
    const cached = cache.get(id);
    if (
      !detectOptions?.force &&
      cached?.environmentKey === currentEnvironmentKey &&
      currentTime - cached.checkedAt < cacheTtlMs
    ) {
      return Promise.resolve(cached.status);
    }

    const inflightKey = `${id}:${currentEnvironmentKey}`;
    const pending = inflight.get(inflightKey);
    if (!detectOptions?.force && pending) return pending;

    const generation = (probeGenerations.get(id) ?? 0) + 1;
    probeGenerations.set(id, generation);
    const force = detectOptions?.force === true;
    const probe = Promise.all([
      runtimeService.getRuntimeStatus('node', { force }),
      loadReleaseMetadata(force),
    ])
      .then(([runtimeStatus, liveMetadata]) => {
        const probedAt = now();
        const usableLiveMetadata = isUsableLiveMetadata(liveMetadata, probedAt)
          ? liveMetadata
          : null;
        const currentNodePath =
          runtimeStatus?.effective?.managedBy === 'nvm' ? runtimeStatus.effective.path : undefined;
        return detectNvm(deps, {
          now: new Date(probedAt),
          schedule,
          ...(currentNodePath !== undefined && { currentNodePath }),
          ...(usableLiveMetadata !== null && {
            latestByMajor: usableLiveMetadata.latestByMajor,
            liveDataAvailable: true,
          }),
        });
      })
      .then((status) => {
        const checkedAt = now();
        if (probeGenerations.get(id) === generation) {
          cache.set(id, {
            checkedAt,
            environmentKey: currentEnvironmentKey,
            status,
          });
        }
        return status;
      })
      .finally(() => {
        if (inflight.get(inflightKey) === probe) inflight.delete(inflightKey);
      });

    inflight.set(inflightKey, probe);
    return probe;
  };

  return {
    getVersionManagerStatus,

    async listVersionManagerStatuses(detectOptions?: VersionManagerDetectionOptions) {
      const status = await getVersionManagerStatus('nvm', detectOptions);
      return status ? [status] : [];
    },

    resetVersionManagerCache(id?: VersionManagerId) {
      if (id) {
        cache.delete(id);
        probeGenerations.set(id, (probeGenerations.get(id) ?? 0) + 1);
        for (const key of inflight.keys()) {
          if (key.startsWith(`${id}:`)) inflight.delete(key);
        }
        return;
      }
      cache.clear();
      inflight.clear();
      for (const managerId of ['nvm', 'fnm', 'volta'] as const) {
        probeGenerations.set(managerId, (probeGenerations.get(managerId) ?? 0) + 1);
      }
    },
  };
}

export const versionManagerDetectionService = createVersionManagerDetectionService();
