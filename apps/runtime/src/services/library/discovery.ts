/**
 * Library discovery on the machine that holds the agent homes.
 *
 * One call scans every enabled location and hashes every instance. Generic
 * remote filesystem ops would turn that into thousands of round-trips; this
 * method exists so a remote scan is one RPC.
 */

import type { LibraryLocationSettings } from '@mangostudio/shared/app-settings';
import {
  enabledLibraryLocations,
  LIBRARY_SCOPES,
  type LibraryLocationId,
  type ResourceKind,
} from '@mangostudio/shared/library';
import { LIBRARY_LOCATION_DEFINITIONS } from '@mangostudio/shared/library/host';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import { throwIfAborted } from '../cancellation';
import { type LibraryCache, libraryCache } from './cache';
import { type ReadLibraryInstance, readLocationInstances } from './instance-reader';

export interface LibraryScanOptions {
  readonly locationSettings: LibraryLocationSettings;
  readonly pathEnv: PathEnv;
  readonly force?: boolean;
  readonly now?: () => number;
  readonly cache?: LibraryCache;
  readonly locationPathOverrides?: Partial<Record<LibraryLocationId, string>>;
  /**
   * Restricts the scan to these kinds. Scanning hashes every byte under every
   * enabled location, so a caller that only consumes one kind (the skill
   * adapter, on the turn hot path) must not pay for the other four.
   */
  readonly kinds?: readonly ResourceKind[];
  /**
   * When false, skip the scan-level memo and only use per-instance hash
   * caching. The hub sets this so it can memoize the grouped resource list
   * under the same signature itself.
   */
  readonly cacheScan?: boolean;
  readonly signal?: AbortSignal;
}

export interface LibraryScanTarget {
  readonly locationId: LibraryLocationId;
  readonly scope: (typeof LIBRARY_LOCATION_DEFINITIONS)[number]['scope'];
  readonly path: string;
}

/** Resolves which absolute paths a settings snapshot would scan. */
export function resolveLibraryScanTargets(
  locationSettings: LibraryLocationSettings,
  pathEnv: PathEnv,
  options: {
    readonly kinds?: readonly ResourceKind[];
    readonly locationPathOverrides?: Partial<Record<LibraryLocationId, string>>;
  } = {}
): LibraryScanTarget[] {
  const enabledByScope = new Map(
    LIBRARY_SCOPES.map((scope) => [scope, enabledLibraryLocations(locationSettings, scope)])
  );
  const kinds = options.kinds ? new Set(options.kinds) : null;
  return LIBRARY_LOCATION_DEFINITIONS.flatMap((location) => {
    if (!enabledByScope.get(location.scope)?.has(location.id)) return [];
    if (kinds && !kinds.has(location.kind)) return [];
    const path = options.locationPathOverrides?.[location.id] ?? location.resolvePath(pathEnv);
    return path ? [{ locationId: location.id, scope: location.scope, path }] : [];
  });
}

/**
 * Reads every enabled location and returns the flat instance list. Grouping,
 * coverage, and divergence are hub decisions over this result — they do not
 * need the filesystem.
 *
 * When `cacheScan` is false, only the per-instance hash memo is used. The hub
 * turns that off so it can memoize the *grouped* `LibraryResource[]` under the
 * same signature; two concurrent matrix loads still coalesce on the instance
 * hashes either way.
 */
export function scanLibraryInstances(
  options: LibraryScanOptions
): Promise<readonly ReadLibraryInstance[]> {
  const targets = resolveLibraryScanTargets(options.locationSettings, options.pathEnv, {
    kinds: options.kinds,
    locationPathOverrides: options.locationPathOverrides,
  });
  // Scope joins the key alongside the resolved path, which is what carries the
  // root: the same location under two workspace roots is two absolute paths and
  // therefore two entries. Scope is redundant with that today and is in the key
  // anyway, so a location that ever resolves to the same path at two scopes
  // cannot silently share one memo entry.
  const signature = `flat:\n${targets
    .map((target) => `${target.scope}\0${target.locationId}\0${target.path}`)
    .sort()
    .join('\n')}`;
  const cache = options.cache ?? libraryCache;
  const force = options.force ?? false;
  const locationById = new Map(
    LIBRARY_LOCATION_DEFINITIONS.map((location) => [location.id, location])
  );

  const compute = async (signal?: AbortSignal): Promise<readonly ReadLibraryInstance[]> => {
    throwIfAborted(signal);
    const scanned = await Promise.all(
      targets.map((target) => {
        throwIfAborted(signal);
        const location = locationById.get(target.locationId);
        if (!location) return Promise.resolve([] as ReadLibraryInstance[]);
        return readLocationInstances(location, target.path, {
          cache,
          force,
          signal,
        });
      })
    );
    return scanned.flat();
  };

  // Cached scans are shared across callers. The walk must not close over one
  // call's AbortSignal, or cancelling the first request rejects every other
  // waiter and cancelling only a waiter is ignored. Each caller refuses on
  // its own signal around the shared promise instead.
  if (options.cacheScan === false) return compute(options.signal);
  return settleUnlessAborted(
    cache.getOrComputeScan(signature, (options.now ?? Date.now)(), force, () => compute()),
    options.signal
  );
}

async function settleUnlessAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;

  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise.then((value) => {
        throwIfAborted(signal);
        return value;
      }),
      new Promise<never>((_, reject) => {
        onAbort = () => {
          try {
            throwIfAborted(signal);
          } catch (error) {
            reject(error);
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
