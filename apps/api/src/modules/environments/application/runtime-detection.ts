import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { RuntimeId, RuntimeStatus } from '@mangostudio/shared/environments';
import { CURSOR_MIN_NODE_VERSION } from '@mangostudio/shared/provider-settings';
import { type BinaryScanDeps, type RuntimeDefinition, scanRuntime } from '../domain/binary-scan';
import { analyzeRuntimeScan, type MinimumRuntimeVersion } from '../domain/duplicate-analysis';
import { BUN_RUNTIME_DEFINITION, NODE_RUNTIME_DEFINITION } from '../domain/runtime-definitions';

const execFileAsync = promisify(execFile);
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_RUNTIME_DEFINITIONS = [BUN_RUNTIME_DEFINITION, NODE_RUNTIME_DEFINITION] as const;

interface RuntimeCacheEntry {
  readonly checkedAt: number;
  readonly environmentKey: string;
  readonly status: RuntimeStatus;
}

interface RuntimeDetectionOptions {
  readonly force?: boolean;
}

export interface RuntimeDetectionService {
  listRuntimeStatuses(options?: RuntimeDetectionOptions): Promise<RuntimeStatus[]>;
  getRuntimeStatus(id: RuntimeId, options?: RuntimeDetectionOptions): Promise<RuntimeStatus | null>;
  resetRuntimeCache(id?: RuntimeId): void;
}

export interface RuntimeDetectionServiceOptions {
  readonly definitions?: readonly RuntimeDefinition[];
  readonly createDeps?: (definition: RuntimeDefinition) => BinaryScanDeps;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
  readonly minimumVersions?: Partial<Record<RuntimeId, MinimumRuntimeVersion>>;
  readonly isInstallable?: (id: RuntimeId, platform: string) => boolean;
}

function parseMinimumVersion(value: string): MinimumRuntimeVersion {
  const [major, minor, patch] = value.split('.').map(Number);
  return {
    major: major ?? 0,
    minor: minor ?? 0,
    ...(patch !== undefined && { patch }),
  };
}

const DEFAULT_MINIMUM_VERSIONS: Partial<Record<RuntimeId, MinimumRuntimeVersion>> = {
  node: parseMinimumVersion(CURSOR_MIN_NODE_VERSION),
};

async function probeBinaryVersion(
  binary: string,
  args: readonly string[],
  timeoutMs: number
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binary, [...args], { timeout: timeoutMs });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function createDefaultScanDeps(): BinaryScanDeps {
  return {
    platform: process.platform,
    homeDir: homedir(),
    env: process.env,
    pathExists: existsSync,
    probeVersion: probeBinaryVersion,
    realpath,
  };
}

function runtimeEnvironmentKey(deps: BinaryScanDeps): string {
  return createHash('sha256')
    .update(deps.platform)
    .update('\0')
    .update(deps.homeDir)
    .update('\0')
    .update(deps.env.PATH ?? '')
    .update('\0')
    .update(deps.env.PATHEXT ?? '')
    .update('\0')
    .update(deps.env.BUN_INSTALL ?? '')
    .update('\0')
    .update(deps.env.NVM_HOME ?? '')
    .update('\0')
    .update(deps.env.NVM_SYMLINK ?? '')
    .update('\0')
    .update(deps.env.FNM_DIR ?? '')
    .update('\0')
    .update(deps.env.VOLTA_HOME ?? '')
    .digest('hex');
}

export function createRuntimeDetectionService(
  options: RuntimeDetectionServiceOptions = {}
): RuntimeDetectionService {
  const definitions = options.definitions ?? DEFAULT_RUNTIME_DEFINITIONS;
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
  const createDeps = options.createDeps ?? createDefaultScanDeps;
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const minimumVersions = {
    ...DEFAULT_MINIMUM_VERSIONS,
    ...options.minimumVersions,
  };
  const isInstallable = options.isInstallable ?? (() => false);
  const cache = new Map<RuntimeId, RuntimeCacheEntry>();
  const inflight = new Map<string, Promise<RuntimeStatus>>();
  const probeGenerations = new Map<RuntimeId, number>();

  const getRuntimeStatus = (
    id: RuntimeId,
    detectOptions?: RuntimeDetectionOptions
  ): Promise<RuntimeStatus | null> => {
    const definition = definitionsById.get(id);
    if (!definition) return Promise.resolve(null);

    const deps = createDeps(definition);
    const environmentKey = runtimeEnvironmentKey(deps);
    const currentTime = now();
    const cached = cache.get(id);
    if (
      !detectOptions?.force &&
      cached?.environmentKey === environmentKey &&
      currentTime - cached.checkedAt < cacheTtlMs
    ) {
      return Promise.resolve(cached.status);
    }

    const inflightKey = `${id}:${environmentKey}`;
    const pending = inflight.get(inflightKey);
    if (!detectOptions?.force && pending) return pending;

    const generation = (probeGenerations.get(id) ?? 0) + 1;
    probeGenerations.set(id, generation);
    const probe = scanRuntime(definition, deps)
      .then((scan) => {
        const probedAtMs = now();
        const status = analyzeRuntimeScan(definition, scan, {
          probedAtMs,
          installable: isInstallable(id, deps.platform),
          minimumVersion: minimumVersions[id],
        });
        if (probeGenerations.get(id) === generation) {
          cache.set(id, { checkedAt: probedAtMs, environmentKey, status });
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
    getRuntimeStatus,

    async listRuntimeStatuses(detectOptions?: RuntimeDetectionOptions) {
      const statuses = await Promise.all(
        definitions.map((definition) => getRuntimeStatus(definition.id, detectOptions))
      );
      return statuses.filter((status): status is RuntimeStatus => status !== null);
    },

    resetRuntimeCache(id?: RuntimeId) {
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
      for (const definition of definitions) {
        const runtimeId = definition.id;
        probeGenerations.set(runtimeId, (probeGenerations.get(runtimeId) ?? 0) + 1);
      }
    },
  };
}

export const runtimeDetectionService = createRuntimeDetectionService();
