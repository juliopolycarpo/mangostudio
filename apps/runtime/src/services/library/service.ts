/**
 * Library scan and contained reads, executed on the machine that holds the
 * agent homes. Policy (which locations are enabled, how long answers stay
 * fresh, coverage over targets) stays on the hub; this host only looks.
 */

import type { LibraryLocationSettings } from '@mangostudio/shared/app-settings';
import type {
  LibraryLocationId,
  LibraryLocationStatus,
  ResourceKind,
} from '@mangostudio/shared/library';
import { describeLocation, LIBRARY_LOCATION_DEFINITIONS } from '@mangostudio/shared/library/host';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import { RuntimeToolArgumentError } from '../../errors';
import type {
  RuntimeLibraryLocationsParams,
  RuntimeLibraryLocationsResult,
  RuntimeLibraryReadParams,
  RuntimeLibraryReadResult,
  RuntimeLibraryScanParams,
  RuntimeLibraryScanResult,
} from '../../methods';
import { createRuntimePathEnv, NODE_LOCATION_FS_PROBE } from '../probing/host-env';
import { type LibraryCache, libraryCache } from './cache';
import { scanLibraryInstances } from './discovery';
import type { ReadLibraryInstance } from './instance-reader';
import { LibraryReadDeniedError, readLibraryContent } from './read';

export interface LibraryHostAdapters {
  readonly createPathEnv: (overrides?: {
    readonly env?: Readonly<Record<string, string>>;
    readonly workspaceRoot?: string;
  }) => PathEnv;
  readonly cache: LibraryCache;
  readonly describeLocations: (env: PathEnv) => LibraryLocationStatus[];
  readonly now: () => number;
}

const DEFAULT_ADAPTERS: LibraryHostAdapters = {
  createPathEnv: createRuntimePathEnv,
  cache: libraryCache,
  describeLocations: (env) =>
    LIBRARY_LOCATION_DEFINITIONS.map((location) =>
      describeLocation(location.id, env, NODE_LOCATION_FS_PROBE)
    ),
  now: Date.now,
};

export interface LibraryService {
  scan(params: RuntimeLibraryScanParams): Promise<RuntimeLibraryScanResult>;
  read(params: RuntimeLibraryReadParams): Promise<RuntimeLibraryReadResult>;
  locations(params: RuntimeLibraryLocationsParams): Promise<RuntimeLibraryLocationsResult>;
  /** Drops every memo this process holds; tests call this between fixtures. */
  resetCache(): void;
}

function assertLocationSettings(value: unknown): asserts value is LibraryLocationSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RuntimeToolArgumentError('library.scan requires locationSettings.');
  }
}

function serializeEntry(entry: ReadLibraryInstance): RuntimeLibraryScanResult['entries'][number] {
  return {
    ref: entry.ref,
    instance: entry.instance,
    ...(entry.whitespaceHash !== undefined && { whitespaceHash: entry.whitespaceHash }),
  };
}

export function createLibraryService(
  adapters: LibraryHostAdapters = DEFAULT_ADAPTERS
): LibraryService {
  return {
    async scan(params) {
      assertLocationSettings(params.locationSettings);
      const pathEnv = adapters.createPathEnv({
        env: params.pathEnv?.env,
        workspaceRoot: params.pathEnv?.workspaceRoot,
      });
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
      try {
        const result = await readLibraryContent({
          path: params.path,
          allowedRoots: params.allowedRoots,
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
      const pathEnv = adapters.createPathEnv({
        env: params.pathEnv?.env,
        workspaceRoot: params.pathEnv?.workspaceRoot,
      });
      return Promise.resolve({ locations: adapters.describeLocations(pathEnv) });
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
