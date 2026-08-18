/**
 * Library scan, contained reads, and write engines executed on the machine that
 * holds the agent homes. Policy (tokens, planning, adapters, acknowledgements)
 * stays on the hub; this host only looks and mutates under a hub-supplied
 * backupRoot.
 */

import { isAbsolute } from 'node:path';
import type { LibraryLocationSettings } from '@mangostudio/shared/app-settings';
import type {
  LibraryLocationId,
  LibraryLocationStatus,
  ResourceKind,
} from '@mangostudio/shared/library';
import { describeLocation, LIBRARY_LOCATION_DEFINITIONS } from '@mangostudio/shared/library/host';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import {
  LIBRARY_BACKUP_MISSING_KIND,
  RuntimeServiceError,
  RuntimeToolArgumentError,
} from '../../errors';
import type {
  RuntimeLibraryApplyParams,
  RuntimeLibraryApplyResult,
  RuntimeLibraryBackupsParams,
  RuntimeLibraryBackupsResult,
  RuntimeLibraryGcParams,
  RuntimeLibraryGcResult,
  RuntimeLibraryLocationsParams,
  RuntimeLibraryLocationsResult,
  RuntimeLibraryReadParams,
  RuntimeLibraryReadResult,
  RuntimeLibraryReadTreeParams,
  RuntimeLibraryReadTreeResult,
  RuntimeLibraryRemoveParams,
  RuntimeLibraryRemoveResult,
  RuntimeLibraryScanParams,
  RuntimeLibraryScanResult,
  RuntimeLibrarySettingsSourcesParams,
  RuntimeLibraryUndoParams,
  RuntimeLibraryUndoResult,
} from '../../methods';
import { throwIfAborted } from '../cancellation';
import { createRuntimePathEnv, NODE_LOCATION_FS_PROBE } from '../probing/host-env';
import { executePropagationWrites } from './apply-writes';
import { collectBackupGarbage, createBackupStoreDeps, listBackupSets } from './backup-store';
import { type LibraryCache, libraryCache } from './cache';
import { scanLibraryInstances } from './discovery';
import {
  InstanceTooLargeError,
  isPathWithin,
  PathEscapeError,
  type ReadLibraryInstance,
  type ReadLocationInstancesResult,
  readLibraryTree,
} from './instance-reader';
import { LibraryReadDeniedError, libraryLocationRoot, readLibraryContent } from './read';
import { executeRemovalWrites } from './remove-writes';
import { type RuntimeSettingsSourcesResult, readSettingsSources } from './settings-sources';
import { executeLibraryUndo, LibraryBackupMissingError } from './undo-writes';
import { serializeRuntimeLibraryWrite } from './write-queue';
import type { PreparedPropagationOperation } from './write-shapes';

export interface LibraryHostAdapters {
  readonly createPathEnv: (overrides?: {
    readonly env?: Readonly<Record<string, string>>;
    readonly workspaceRoot?: string;
  }) => PathEnv;
  readonly cache: LibraryCache;
  readonly describeLocations: (env: PathEnv) => LibraryLocationStatus[];
  readonly readSettingsSources: (env: PathEnv) => RuntimeSettingsSourcesResult;
  readonly now: () => number;
  /** Every write against one backup root runs alone; see `write-queue.ts`. */
  readonly serializeWrite: <T>(backupRoot: string, task: () => Promise<T>) => Promise<T>;
}

const DEFAULT_ADAPTERS: LibraryHostAdapters = {
  createPathEnv: createRuntimePathEnv,
  cache: libraryCache,
  describeLocations: (env) =>
    LIBRARY_LOCATION_DEFINITIONS.map((location) =>
      describeLocation(location.id, env, NODE_LOCATION_FS_PROBE)
    ),
  readSettingsSources,
  now: Date.now,
  serializeWrite: serializeRuntimeLibraryWrite,
};

export interface LibraryService {
  scan(params: RuntimeLibraryScanParams, signal?: AbortSignal): Promise<RuntimeLibraryScanResult>;
  read(params: RuntimeLibraryReadParams): Promise<RuntimeLibraryReadResult>;
  readTree(
    params: RuntimeLibraryReadTreeParams,
    signal?: AbortSignal
  ): Promise<RuntimeLibraryReadTreeResult>;
  locations(params: RuntimeLibraryLocationsParams): Promise<RuntimeLibraryLocationsResult>;
  settingsSources(
    params: RuntimeLibrarySettingsSourcesParams
  ): Promise<RuntimeSettingsSourcesResult>;
  apply(
    params: RuntimeLibraryApplyParams,
    signal?: AbortSignal
  ): Promise<RuntimeLibraryApplyResult>;
  remove(
    params: RuntimeLibraryRemoveParams,
    signal?: AbortSignal
  ): Promise<RuntimeLibraryRemoveResult>;
  undo(params: RuntimeLibraryUndoParams, signal?: AbortSignal): Promise<RuntimeLibraryUndoResult>;
  backups(params: RuntimeLibraryBackupsParams): Promise<RuntimeLibraryBackupsResult>;
  gc(params: RuntimeLibraryGcParams): Promise<RuntimeLibraryGcResult>;
  /** Drops every memo this process holds; tests call this between fixtures. */
  resetCache(): void;
}

function assertLocationSettings(value: unknown): asserts value is LibraryLocationSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RuntimeToolArgumentError('library.scan requires locationSettings.');
  }
}

function assertBackupRoot(value: unknown, method: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeToolArgumentError(`${method} requires a non-empty backupRoot.`);
  }
  // Platform-local absolute check: backupRoot names a path on this host, and a
  // relative value would resolve against the runtime cwd rather than the hub's
  // intended retention tree.
  if (!isAbsolute(value)) {
    throw new RuntimeToolArgumentError(`${method} requires an absolute backupRoot.`);
  }
}

function serializeEntry(entry: ReadLibraryInstance): RuntimeLibraryScanResult['entries'][number] {
  return {
    ref: entry.ref,
    instance: entry.instance,
    ...(entry.whitespaceHash !== undefined && { whitespaceHash: entry.whitespaceHash }),
  };
}

function pathEnvFrom(
  adapters: LibraryHostAdapters,
  params: {
    readonly pathEnv?: {
      readonly env?: Readonly<Record<string, string>>;
      readonly workspaceRoot?: string;
    };
  }
): PathEnv {
  return adapters.createPathEnv({
    env: params.pathEnv?.env,
    workspaceRoot: params.pathEnv?.workspaceRoot,
  });
}

function decodeApplyOperations(params: RuntimeLibraryApplyParams): PreparedPropagationOperation[] {
  // One decode per distinct payload, not per operation: the whole point of the
  // shared `contents` map is that a fan-out across destinations carries the
  // bytes once, and decoding per operation would put every copy back in memory.
  const decoded = new Map<string, Uint8Array>();
  const payload = (contentRef: string, what: string): Uint8Array => {
    const encoded = params.contents?.[contentRef];
    if (encoded === undefined) {
      throw new RuntimeToolArgumentError(`library.apply ${what} names no content in this frame.`);
    }
    let bytes = decoded.get(contentRef);
    if (!bytes) {
      bytes = Buffer.from(encoded, 'base64');
      decoded.set(contentRef, bytes);
    }
    return bytes;
  };

  return params.operations.map((operation) => {
    if (operation.kind === 'directory') {
      if (operation.files !== undefined) {
        return {
          ...operation,
          files: operation.files.map((file) => ({
            relativePath: file.relativePath,
            contents: payload(
              file.contentRef,
              `directory operation "${operation.resourceKey}" file "${file.relativePath}"`
            ),
          })),
        };
      }
      if (typeof operation.sourceDir !== 'string' || operation.sourceDir.length === 0) {
        throw new RuntimeToolArgumentError(
          `library.apply directory operation "${operation.resourceKey}" requires sourceDir or files.`
        );
      }
      const { files: _sameMachine, ...rest } = operation;
      return {
        ...rest,
        sourceDir: operation.sourceDir,
      };
    }
    if (operation.contentRef === undefined) {
      throw new RuntimeToolArgumentError(
        `library.apply file operation "${operation.resourceKey}" names no content in this frame.`
      );
    }
    const { files: _never, ...rest } = operation;
    return {
      ...rest,
      contents: payload(operation.contentRef, `file operation "${operation.resourceKey}"`),
    };
  });
}

export function createLibraryService(overrides: Partial<LibraryHostAdapters> = {}): LibraryService {
  const adapters: LibraryHostAdapters = { ...DEFAULT_ADAPTERS, ...overrides };
  return {
    async scan(params, signal) {
      throwIfAborted(signal);
      assertLocationSettings(params.locationSettings);
      const pathEnv = pathEnvFrom(adapters, params);
      const result = await scanLibraryInstances({
        locationSettings: params.locationSettings,
        pathEnv,
        force: params.force === true,
        now: adapters.now,
        cache: adapters.cache,
        kinds: params.kinds,
        locationPathOverrides: params.locationPathOverrides,
        signal,
      });
      return {
        entries: result.instances.map(serializeEntry),
        unreadableEntries: result.unreadableEntries,
      };
    },

    async read(params) {
      const pathEnv = pathEnvFrom(adapters, params);
      const root = libraryLocationRoot(params.locationId, pathEnv);
      if (root === null) {
        return {
          denied: true,
          reason: `Library location "${params.locationId}" does not resolve on this machine.`,
          content: '',
          truncated: false,
          sizeBytes: 0,
        };
      }
      try {
        const result = await readLibraryContent({
          path: params.path,
          root,
          maxBytes: params.maxBytes,
          truncateOversize: params.truncateOversize,
        });
        return result;
      } catch (error) {
        if (error instanceof LibraryReadDeniedError) {
          return {
            denied: true,
            reason: error.message,
            content: '',
            truncated: false,
            sizeBytes: 0,
          };
        }
        throw error;
      }
    },

    async readTree(params, signal) {
      throwIfAborted(signal);
      const pathEnv = pathEnvFrom(adapters, params);
      const root = libraryLocationRoot(params.locationId, pathEnv);
      if (root === null) {
        return {
          files: [],
          denied: true,
          reason: `Library location "${params.locationId}" does not resolve on this machine.`,
        };
      }
      // Containment is checked against the location root before the walk; a
      // hub-supplied path is rejected here if it is not even textually inside
      // the location, and `readLibraryTree` re-checks every path — the root
      // itself and every leaf — against the same root after symlink
      // resolution.
      if (!isPathWithin(root, params.path)) {
        return {
          files: [],
          denied: true,
          reason: `Library path "${params.path}" is outside its registered location.`,
        };
      }
      try {
        const files = await readLibraryTree(params.path, root, { signal });
        return {
          files: files.map((file) => ({
            relativePath: file.relativePath,
            contentBase64: Buffer.from(file.bytes).toString('base64'),
          })),
        };
      } catch (error) {
        if (error instanceof PathEscapeError) {
          return {
            files: [],
            denied: true,
            reason: `Library path "${params.path}" resolves outside its registered location.`,
          };
        }
        if (error instanceof InstanceTooLargeError) {
          return {
            files: [],
            denied: true,
            reason: `Library resource at "${params.path}" exceeds the transfer limits.`,
          };
        }
        throw error;
      }
    },

    locations(params) {
      const pathEnv = pathEnvFrom(adapters, params);
      return Promise.resolve({ locations: adapters.describeLocations(pathEnv) });
    },

    settingsSources(params) {
      const pathEnv = pathEnvFrom(adapters, params);
      return Promise.resolve(adapters.readSettingsSources(pathEnv));
    },

    apply(params, signal) {
      assertBackupRoot(params.backupRoot, 'library.apply');
      return adapters.serializeWrite(params.backupRoot, () =>
        executePropagationWrites({
          backupRoot: params.backupRoot,
          retentionCount: params.retentionCount,
          retentionBytes: params.retentionBytes,
          pathEnv: pathEnvFrom(adapters, params),
          backupId: params.backupId,
          environmentId: params.environmentId,
          operations: decodeApplyOperations(params),
          signal,
        })
      );
    },

    remove(params, signal) {
      assertBackupRoot(params.backupRoot, 'library.remove');
      return adapters.serializeWrite(params.backupRoot, () =>
        executeRemovalWrites({
          backupRoot: params.backupRoot,
          retentionCount: params.retentionCount,
          retentionBytes: params.retentionBytes,
          pathEnv: pathEnvFrom(adapters, params),
          backupId: params.backupId,
          environmentId: params.environmentId,
          operations: params.operations,
          lastCopyResourceKeys: params.lastCopyResourceKeys,
          signal,
        })
      );
    },

    async undo(params, signal) {
      assertBackupRoot(params.backupRoot, 'library.undo');
      if (typeof params.backupId !== 'string' || params.backupId.length === 0) {
        throw new RuntimeToolArgumentError('library.undo requires a non-empty backupId.');
      }
      const backupId = params.backupId;
      try {
        return await adapters.serializeWrite(params.backupRoot, () =>
          executeLibraryUndo({
            backupRoot: params.backupRoot,
            backupId,
            pathEnv: pathEnvFrom(adapters, params),
            signal,
          })
        );
      } catch (error) {
        if (error instanceof LibraryBackupMissingError) {
          // Kept discriminable across the boundary: the class does not survive
          // the frame, and the hub answers 404 for exactly this case.
          throw new RuntimeServiceError(LIBRARY_BACKUP_MISSING_KIND, error.message);
        }
        throw error;
      }
    },

    async backups(params) {
      assertBackupRoot(params.backupRoot, 'library.backups');
      return { sets: await listBackupSets(backupStoreDepsFor(params)) };
    },

    gc(params) {
      assertBackupRoot(params.backupRoot, 'library.gc');
      // Serialized against writes on the same root: a prune racing an apply
      // could evict the set that apply is still filling, and the caller would
      // hold a backup id with nothing behind it.
      return adapters.serializeWrite(params.backupRoot, () =>
        collectBackupGarbage(
          { ...(params.purgeBackupIds && { purgeBackupIds: params.purgeBackupIds }) },
          backupStoreDepsFor(params)
        )
      );
    },

    resetCache() {
      adapters.cache.clear();
    },
  };
}

/**
 * Retention bounds are optional on the wire and default in the store, so a
 * caller that only wants a listing never has to restate hub policy — and a
 * malformed one cannot widen the budget past what the hub configured.
 */
function backupStoreDepsFor(params: {
  readonly backupRoot: string;
  readonly retentionCount?: number;
  readonly retentionBytes?: number;
}) {
  return createBackupStoreDeps({
    backupRoot: params.backupRoot,
    ...(params.retentionCount !== undefined && { retentionCount: params.retentionCount }),
    ...(params.retentionBytes !== undefined && { retentionBytes: params.retentionBytes }),
  });
}

export const libraryService = createLibraryService();

/** In-process scan used by the hub for Local parity and unit tests. */
export function scanLibraryInstancesForPathEnv(
  locationSettings: LibraryLocationSettings,
  pathEnv: PathEnv,
  options: {
    readonly force?: boolean;
    readonly now?: () => number;
    readonly cache?: LibraryCache;
    readonly kinds?: readonly ResourceKind[];
    readonly locationPathOverrides?: Partial<Record<LibraryLocationId, string>>;
    readonly cacheScan?: boolean;
  } = {}
): Promise<ReadLocationInstancesResult> {
  return scanLibraryInstances({
    locationSettings,
    pathEnv,
    ...options,
  });
}
