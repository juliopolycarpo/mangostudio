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
import type {
  LibraryLocationId,
  LibraryLocationStatus,
  LibraryResource,
  LibraryResourceContent,
  LibraryScanResult,
  ResourceKind,
} from '@mangostudio/shared/library';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import type { RuntimeClient } from '../../../services/runtime-client/runtime-client';
import { getRuntimeClient } from '../../../services/runtime-client/runtime-connection-manager';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import {
  type EnvironmentProbingService,
  environmentProbingService,
} from '../../environments/application/probing-service';
import { LibraryFeatureUnavailableError } from '../domain/library-feature-error';
import { hubLibraryPathEnvParams } from '../infrastructure/location-probe';
import { groupLibraryScanEntries } from './library-discovery';
import type { SettingsSourcePayload } from './settings-inspection';

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
  ): Promise<LibraryScanResult>;
  /**
   * `workspaceRoot` is accepted and validated at the route, but cannot change
   * the answer: v1 registers no workspace-scoped location, so the matrix is
   * home-scoped either way. It stays in the signature for the day one does —
   * see the reserved-parameter note on the `/library/locations` route.
   */
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
  readSettingsSources(scope: LibraryScope): Promise<SettingsSourcePayload>;
  resetCache(environmentId?: string): void;
}

interface CacheEntry {
  readonly scannedAtMs: number;
  readonly client: RuntimeClient;
  readonly scan: LibraryScanResult;
  readonly environmentId: string;
}

export interface EnvironmentLibraryServiceOptions {
  readonly resolveClient?: (scope: LibraryScope) => Promise<RuntimeClient>;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
  readonly requestTimeoutMs?: number;
  readonly listLocationStatuses?: EnvironmentProbingService['listLocationStatuses'];
  readonly resetLocationCache?: EnvironmentProbingService['resetLocationCache'];
}

/**
 * Nothing expires an entry on its own, and every part of the signature is
 * caller-supplied — user, environment, workspace root, kinds, settings — so an
 * unbounded map would hold one whole `LibraryResource[]` matrix per combination
 * for the life of the process. Insertion order is the eviction order; losing the
 * oldest entry costs one rescan.
 */
const MAX_CACHE_ENTRIES = 64;

function setBounded<K, V>(entries: Map<K, V>, key: K, value: V, maxEntries: number): void {
  entries.delete(key);
  entries.set(key, value);
  while (entries.size > maxEntries) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
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
  const listLocationStatuses =
    options.listLocationStatuses ?? environmentProbingService.listLocationStatuses;
  const resetLocationCache =
    options.resetLocationCache ??
    ((environmentId?: string) => environmentProbingService.resetLocationCache(environmentId));
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<LibraryScanResult>>();
  const scanGeneration = new Map<string, number>();
  // Bumped on every resetCache so an in-flight non-forced scan cannot write
  // pre-reset results after scanGeneration keys were cleared (both sides 0).
  let resetEpoch = 0;

  const scopeKey = (scope: LibraryScope) => `${scope.userId}${SCOPE_SEP}${scope.environmentId}`;
  const pathEnvParams = (scope: LibraryScope, workspaceRoot?: string) =>
    hubLibraryPathEnvParams(scope.environmentId, {
      ...(workspaceRoot !== undefined && { workspaceRoot }),
    }) ?? {};

  const discover = async (
    db: Kysely<Database>,
    scope: LibraryScope,
    discoverOptions: EnvironmentLibraryDiscoverOptions = {}
  ): Promise<LibraryScanResult> => {
    const force = discoverOptions.force === true;
    // Before the first await, so a caller that asks for both at once — the
    // propagation preview does — cannot have its location read start against
    // the pre-rescan cache. Locations share the probing TTL now, so without
    // this the matrix redraws its columns from the state the rescan replaced.
    if (force) resetLocationCache(scope.environmentId);

    const client = await resolveClient(scope);
    if (!client.manifest.features.library) {
      throw new LibraryFeatureUnavailableError(
        `Environment "${scope.environmentId}" does not advertise library discovery.`
      );
    }

    const settings = await getAppSettings(db, scope.userId);
    const locationSettings = libraryLocationsFor(settings);
    const kindsKey = discoverOptions.kinds ? [...discoverOptions.kinds].sort().join(',') : '';
    const signature = [
      scopeKey(scope),
      discoverOptions.workspaceRoot ?? '',
      kindsKey,
      JSON.stringify(locationSettings),
    ].join(SCOPE_SEP);

    if (!force) {
      const cached = cache.get(signature);
      if (cached && cached.client === client && now() - cached.scannedAtMs < cacheTtlMs) {
        return cached.scan;
      }
    } else {
      scanGeneration.set(signature, (scanGeneration.get(signature) ?? 0) + 1);
    }

    const pending = inflight.get(signature);
    if (pending && !force) return pending;

    const generationAtStart = scanGeneration.get(signature) ?? 0;
    const epochAtStart = resetEpoch;

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
      const scan: LibraryScanResult = {
        resources: groupLibraryScanEntries(result.entries as RuntimeLibraryScanEntry[]),
        // Additive protocol field. A runtime a release behind still connects —
        // the handshake only pins major/minor — and answers without this key,
        // so spreading it unguarded would turn "no unreadable entries" into a
        // TypeError that takes the whole scan down.
        unreadableEntries: [...(result.unreadableEntries ?? [])],
      };
      if (
        (scanGeneration.get(signature) ?? 0) === generationAtStart &&
        resetEpoch === epochAtStart
      ) {
        setBounded(
          cache,
          signature,
          { scannedAtMs: now(), client, scan, environmentId: scope.environmentId },
          MAX_CACHE_ENTRIES
        );
      }
      return scan;
    })().finally(() => {
      if (inflight.get(signature) === scanning) inflight.delete(signature);
    });

    inflight.set(signature, scanning);
    return scanning;
  };

  return {
    discover,

    // Location health is resolved entirely on the target machine, so no hub
    // settings read stands between the request and the runtime. None of the
    // registered locations are workspace-scoped, so `workspaceRoot` cannot
    // change the answer — the probing service's shared cache does not key on
    // it, matching how the agent-CLI probe already reads these same paths.
    //
    // The manifest guard lives with the RPC rather than here: resolving the
    // connection twice would check one and call the other, so a reconnect
    // between them passes a manifest that did not answer the request.
    async listLocations(_db, scope, _workspaceRoot) {
      return [...(await listLocationStatuses(scope))];
    },

    // The instance already carries the absolute path the scan found, so this
    // reads no hub settings: the caller's `discover` is what applied them.
    async readContent(_db, scope, resource, locationId, workspaceRoot) {
      const instance = resource.instances.find((candidate) => candidate.locationId === locationId);
      if (!instance) return null;

      const client = await resolveClient(scope);
      if (!client.manifest.features.library) {
        throw new LibraryFeatureUnavailableError(
          `Environment "${scope.environmentId}" does not advertise library discovery.`
        );
      }

      // The location is named, not resolved: the runtime turns it into a root
      // against its own layout, so the hub never guesses where another
      // machine's agent homes are.
      const contentPath = libraryContentPath(resource.ref.kind, instance.path);
      const result = await client.library.read(
        {
          path: contentPath,
          locationId,
          pathEnv: pathEnvParams(scope, workspaceRoot),
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

    // Settings are read fresh every time. The comparison is one small read per
    // location and it is what a user opens *after* editing a settings file, so
    // a cache here would answer with the state they just changed.
    async readSettingsSources(scope) {
      const client = await resolveClient(scope);
      if (!client.manifest.features.library) {
        throw new LibraryFeatureUnavailableError(
          `Environment "${scope.environmentId}" does not advertise library discovery.`
        );
      }
      return client.library.settingsSources(
        { pathEnv: pathEnvParams(scope) },
        { timeoutMs: requestTimeoutMs }
      );
    },

    resetCache(environmentId) {
      resetEpoch += 1;
      resetLocationCache(environmentId);
      if (!environmentId) {
        cache.clear();
        inflight.clear();
        scanGeneration.clear();
        return;
      }
      for (const [key, entry] of [...cache.entries()]) {
        if (entry.environmentId === environmentId) cache.delete(key);
      }
      // Signature layout is `userId SEP environmentId SEP …`, so index 1 is the
      // environment for both of the by-key maps.
      for (const key of [...inflight.keys()]) {
        if (key.split(SCOPE_SEP)[1] === environmentId) inflight.delete(key);
      }
      for (const key of [...scanGeneration.keys()]) {
        if (key.split(SCOPE_SEP)[1] === environmentId) scanGeneration.delete(key);
      }
    },
  };
}

export const environmentLibraryService = createEnvironmentLibraryService();

/**
 * Drops scan and location-health caches for each distinct environment a write
 * just touched. Location listing shares the probing TTL, so a create or delete
 * would otherwise keep reporting the pre-write exists/entryCount until it
 * expires.
 */
export function resetLibraryCachesForEnvironments(
  rows: Iterable<{ readonly environmentId: string }>,
  // An overrides object rather than a positional default, matching the apply
  // and removal modules that hold this function as a dependency: a bare second
  // parameter is one `.forEach` away from being handed an index that
  // type-checks as the reset it is standing in for.
  overrides: { readonly resetCache?: EnvironmentLibraryService['resetCache'] } = {}
): void {
  const resetCache =
    overrides.resetCache ??
    ((environmentId?: string) => environmentLibraryService.resetCache(environmentId));
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.environmentId)) continue;
    seen.add(row.environmentId);
    resetCache(row.environmentId);
  }
}
