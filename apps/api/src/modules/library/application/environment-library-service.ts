/**
 * Library scan and contained reads for a chosen environment.
 *
 * The looking happens on the runtime; what stays here is everything that is a
 * hub decision — which locations the user enabled, how long an answer may be
 * reused, coverage over targets, and who is allowed to ask. Cache entries are
 * keyed by environment *and* by the connection that produced them: a runtime
 * that reconnected is a machine that may have changed underneath, so its
 * entries are dropped rather than carried across the gap.
 */

import {
  libraryContentPath,
  MAX_LIBRARY_CONTENT_BYTES,
  type RuntimeLibraryScanEntry,
} from '@mangostudio/runtime';
import { libraryLocationsFor } from '@mangostudio/shared/app-settings';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type {
  LibraryLocationId,
  LibraryLocationStatus,
  LibraryResource,
  LibraryResourceContent,
  ResourceKind,
} from '@mangostudio/shared/library';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import type { RuntimeClient } from '../../../services/runtime-client/runtime-client';
import { getRuntimeClient } from '../../../services/runtime-client/runtime-connection-manager';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import { configuredLibraryEnv } from '../infrastructure/location-probe';
import { groupLibraryScanEntries } from './library-discovery';

/**
 * Remote scans hash every enabled location; the hub's own deadline sits above
 * the runtime work so a dead link and an over-running scan stay distinguishable.
 */
const LIBRARY_REQUEST_TIMEOUT_MS = 60_000;

export interface LibraryScope {
  readonly userId: string;
  readonly environmentId: string;
}

interface EnvironmentLibraryDiscoverOptions {
  readonly force?: boolean;
  readonly workspaceRoot?: string;
  readonly kinds?: readonly ResourceKind[];
}

export interface EnvironmentLibraryService {
  discover(
    db: Kysely<Database>,
    scope: LibraryScope,
    options?: EnvironmentLibraryDiscoverOptions
  ): Promise<LibraryResource[]>;
  listLocations(
    db: Kysely<Database>,
    scope: LibraryScope,
    workspaceRoot?: string
  ): Promise<LibraryLocationStatus[]>;
  readContent(
    db: Kysely<Database>,
    scope: LibraryScope,
    resource: LibraryResource,
    locationId: LibraryLocationId,
    workspaceRoot?: string
  ): Promise<LibraryResourceContent | null>;
  resetCache(environmentId?: string): void;
}

interface CacheEntry {
  readonly scannedAtMs: number;
  readonly client: RuntimeClient;
  readonly resources: LibraryResource[];
  readonly environmentId: string;
  readonly signature: string;
}

export interface EnvironmentLibraryServiceOptions {
  readonly resolveClient?: (scope: LibraryScope) => Promise<RuntimeClient>;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
  readonly requestTimeoutMs?: number;
}

const DEFAULT_CACHE_TTL_MS = 2_000;
const SCOPE_SEP = '\u001f';

export function createEnvironmentLibraryService(
  options: EnvironmentLibraryServiceOptions = {}
): EnvironmentLibraryService {
  const resolveClient =
    options.resolveClient ?? ((scope) => getRuntimeClient(scope.userId, scope.environmentId));
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? LIBRARY_REQUEST_TIMEOUT_MS;
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<LibraryResource[]>>();

  const scopeKey = (scope: LibraryScope) => `${scope.userId}${SCOPE_SEP}${scope.environmentId}`;
  const isHubMachine = (environmentId: string) => environmentId === LOCAL_ENVIRONMENT_ID;

  const pathEnvParams = (scope: LibraryScope, workspaceRoot?: string) => ({
    ...(isHubMachine(scope.environmentId) && { env: configuredLibraryEnv() }),
    ...(workspaceRoot !== undefined && { workspaceRoot }),
  });

  const discover = async (
    db: Kysely<Database>,
    scope: LibraryScope,
    discoverOptions: EnvironmentLibraryDiscoverOptions = {}
  ): Promise<LibraryResource[]> => {
    const client = await resolveClient(scope);
    if (!client.manifest.features.library) {
      throw new LibraryFeatureUnavailableError(
        `Environment "${scope.environmentId}" does not advertise library discovery.`
      );
    }

    const settings = await getAppSettings(db, scope.userId);
    const locationSettings = libraryLocationsFor(settings);
    const force = discoverOptions.force === true;
    const kindsKey = discoverOptions.kinds ? [...discoverOptions.kinds].sort().join(',') : '';
    const signature = [
      scopeKey(scope),
      discoverOptions.workspaceRoot ?? '',
      kindsKey,
      JSON.stringify(locationSettings),
    ].join(SCOPE_SEP);

    if (!force) {
      const cached = cache.get(signature);
      if (
        cached &&
        cached.client === client &&
        now() - cached.scannedAtMs < cacheTtlMs &&
        cached.signature === signature
      ) {
        return cached.resources;
      }
    }

    const pending = inflight.get(signature);
    if (pending && !force) return pending;

    const scanning = (async () => {
      const result = await client.library.scan(
        {
          locationSettings,
          force,
          ...(discoverOptions.kinds && { kinds: discoverOptions.kinds }),
          pathEnv: pathEnvParams(scope, discoverOptions.workspaceRoot),
        },
        { timeoutMs: requestTimeoutMs }
      );
      const resources = groupLibraryScanEntries(result.entries as RuntimeLibraryScanEntry[]);
      cache.set(signature, {
        scannedAtMs: now(),
        client,
        resources,
        environmentId: scope.environmentId,
        signature,
      });
      return resources;
    })().finally(() => {
      if (inflight.get(signature) === scanning) inflight.delete(signature);
    });

    inflight.set(signature, scanning);
    return scanning;
  };

  return {
    discover,

    async listLocations(db, scope, workspaceRoot) {
      const client = await resolveClient(scope);
      if (!client.manifest.features.library) {
        throw new LibraryFeatureUnavailableError(
          `Environment "${scope.environmentId}" does not advertise library discovery.`
        );
      }
      // Ensure settings load fails closed for a missing user the same way discover does.
      await getAppSettings(db, scope.userId);
      const result = await client.library.locations(
        { pathEnv: pathEnvParams(scope, workspaceRoot) },
        { timeoutMs: requestTimeoutMs }
      );
      return [...result.locations];
    },

    async readContent(db, scope, resource, locationId, _workspaceRoot) {
      const instance = resource.instances.find((candidate) => candidate.locationId === locationId);
      if (!instance) return null;

      const client = await resolveClient(scope);
      if (!client.manifest.features.library) {
        throw new LibraryFeatureUnavailableError(
          `Environment "${scope.environmentId}" does not advertise library discovery.`
        );
      }

      // Fail closed for a missing user the same way discover does.
      await getAppSettings(db, scope.userId);

      // Containment is against the scanned instance path itself — hub-resolved
      // location roots can disagree with a remote machine's layout, while the
      // instance path came from that machine's scan.
      const allowedRoots = [instance.path];
      const contentPath = libraryContentPath(resource.ref.kind, instance.path);
      const result = await client.library.read(
        {
          path: contentPath,
          allowedRoots,
          maxBytes: MAX_LIBRARY_CONTENT_BYTES,
          truncateOversize: true,
        },
        { timeoutMs: requestTimeoutMs }
      );
      if (result.denied) return null;
      return {
        key: resource.key,
        locationId,
        content: result.content,
        truncated: result.truncated,
        sizeBytes: result.sizeBytes,
      };
    },

    resetCache(environmentId) {
      if (!environmentId) {
        cache.clear();
        inflight.clear();
        return;
      }
      for (const [key, entry] of [...cache.entries()]) {
        if (entry.environmentId === environmentId) cache.delete(key);
      }
      for (const key of [...inflight.keys()]) {
        if (key.split(SCOPE_SEP)[1] === environmentId) inflight.delete(key);
      }
    },
  };
}

export class LibraryFeatureUnavailableError extends Error {
  readonly code = 'LIBRARY_FEATURE_UNAVAILABLE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'LibraryFeatureUnavailableError';
  }
}

export const environmentLibraryService = createEnvironmentLibraryService();
