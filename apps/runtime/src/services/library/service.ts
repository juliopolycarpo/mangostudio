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
  RuntimeLibraryLocationsParams,
  RuntimeLibraryLocationsResult,
  RuntimeLibraryReadParams,
  RuntimeLibraryReadResult,
  RuntimeLibraryRemoveParams,
  RuntimeLibraryRemoveResult,
  RuntimeLibraryScanParams,
  RuntimeLibraryScanResult,
  RuntimeLibrarySettingsSourcesParams,
  RuntimeLibraryUndoParams,
  RuntimeLibraryUndoResult,
} from '../../methods';
import { createRuntimePathEnv, NODE_LOCATION_FS_PROBE } from '../probing/host-env';
import { executePropagationWrites } from './apply-writes';
import { type LibraryCache, libraryCache } from './cache';
import { scanLibraryInstances } from './discovery';
import type { ReadLibraryInstance } from './instance-reader';
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
  scan(params: RuntimeLibraryScanParams): Promise<RuntimeLibraryScanResult>;
  read(params: RuntimeLibraryReadParams): Promise<RuntimeLibraryReadResult>;
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
  return params.operations.map((operation) => {
    if (operation.kind === 'directory') {
      if (typeof operation.sourceDir !== 'string' || operation.sourceDir.length === 0) {
        throw new RuntimeToolArgumentError(
          `library.apply directory operation "${operation.resourceKey}" requires sourceDir.`
        );
      }
      return {
        ...operation,
        sourceDir: operation.sourceDir,
      };
    }
    const encoded =
      operation.contentRef === undefined ? undefined : params.contents?.[operation.contentRef];
    if (encoded === undefined) {
      throw new RuntimeToolArgumentError(
        `library.apply file operation "${operation.resourceKey}" names no content in this frame.`
      );
    }
    let contents = decoded.get(operation.contentRef as string);
    if (!contents) {
      contents = Buffer.from(encoded, 'base64');
      decoded.set(operation.contentRef as string, contents);
    }
    return { ...operation, contents };
  });
}

export function createLibraryService(overrides: Partial<LibraryHostAdapters> = {}): LibraryService {
  const adapters: LibraryHostAdapters = { ...DEFAULT_ADAPTERS, ...overrides };
  return {
    async scan(params) {
      assertLocationSettings(params.locationSettings);
      const pathEnv = pathEnvFrom(adapters, params);
      const entries = await scanLibraryInstances({
        locationSettings: params.locationSettings,
        pathEnv,
        force: params.force === true,
        now: adapters.now,
        cache: adapters.cache,
        kinds: params.kinds,
        locationPathOverrides: params.locationPathOverrides,
      });
      return { entries: entries.map(serializeEntry) };
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

    resetCache() {
      adapters.cache.clear();
    },
  };
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
): Promise<readonly ReadLibraryInstance[]> {
  return scanLibraryInstances({
    locationSettings,
    pathEnv,
    ...options,
  });
}
