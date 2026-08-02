import type { AppSettings } from '@mangostudio/shared/app-settings';
import { libraryLocationsFor } from '@mangostudio/shared/app-settings';
import {
  enabledLibraryLocations,
  LIBRARY_LOCATION_DEFINITIONS,
  LIBRARY_SCOPES,
  type LibraryLocationId,
  type LibraryResource,
  type ResourceKind,
  resourceKey,
} from '@mangostudio/shared/library';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import { readLocationInstances } from '../infrastructure/instance-reader';
import { type LibraryCache, libraryCache } from '../infrastructure/library-cache';
import { createLibraryPathEnv } from '../infrastructure/location-probe';
import { resolveLibraryCoverage } from './coverage-resolver';
import { describeDivergence, type InstanceComparison } from './divergence';

export interface LibraryDiscoveryOptions {
  readonly force?: boolean;
  readonly now?: () => number;
  readonly pathEnv?: PathEnv;
  readonly cache?: LibraryCache;
  readonly settings?: AppSettings;
  readonly locationPathOverrides?: Partial<Record<LibraryLocationId, string>>;
  /**
   * Restricts the scan to these kinds. Scanning hashes every byte under every
   * enabled location, so a caller that only consumes one kind (the skill
   * adapter, on the turn hot path) must not pay for the other four.
   */
  readonly kinds?: readonly ResourceKind[];
}

export async function discoverLibraryResources(
  db: Kysely<Database>,
  userId: string,
  options: LibraryDiscoveryOptions = {}
): Promise<LibraryResource[]> {
  const settings = options.settings ?? (await getAppSettings(db, userId));
  return discoverLibraryResourcesFromSettings(settings, options);
}

/** Discover library resources without a database when settings are already known (CLI). */
export async function discoverLibraryResourcesFromSettings(
  settings: AppSettings,
  options: Omit<LibraryDiscoveryOptions, 'settings'> = {}
): Promise<LibraryResource[]> {
  const pathEnv = options.pathEnv ?? createLibraryPathEnv();
  const locationSettings = libraryLocationsFor(settings);
  const enabledByScope = new Map(
    LIBRARY_SCOPES.map((scope) => [scope, enabledLibraryLocations(locationSettings, scope)])
  );
  const kinds = options.kinds ? new Set(options.kinds) : null;
  const locations = LIBRARY_LOCATION_DEFINITIONS.flatMap((location) => {
    if (!enabledByScope.get(location.scope)?.has(location.id)) return [];
    if (kinds && !kinds.has(location.kind)) return [];
    const path = options.locationPathOverrides?.[location.id] ?? location.resolvePath(pathEnv);
    return path ? [{ location, path }] : [];
  });
  // Scope joins the key alongside the resolved path, which is what carries the
  // root: the same location under two workspace roots is two absolute paths and
  // therefore two entries. Scope is redundant with that today and is in the key
  // anyway, so a location that ever resolves to the same path at two scopes
  // cannot silently share one memo entry.
  const signature = locations
    .map(({ location, path }) => `${location.scope}\0${location.id}\0${path}`)
    .sort()
    .join('\n');
  const cache = options.cache ?? libraryCache;
  const force = options.force ?? false;

  return await cache.getOrComputeScan(signature, (options.now ?? Date.now)(), force, async () => {
    const scanned = (
      await Promise.all(
        locations.map(({ location, path }) =>
          readLocationInstances(location, path, { cache, force })
        )
      )
    ).flat();
    return groupResources(scanned);
  });
}

function groupResources(
  scanned: readonly {
    readonly ref: { readonly kind: LibraryResource['ref']['kind']; readonly slug: string };
    readonly instance: LibraryResource['instances'][number];
    readonly whitespaceHash?: string;
  }[]
): LibraryResource[] {
  const byKey = new Map<string, InstanceComparison[]>();
  const refByKey = new Map<string, LibraryResource['ref']>();

  for (const entry of scanned) {
    const key = resourceKey(entry.ref.kind, entry.ref.slug);
    const instances = byKey.get(key) ?? [];
    instances.push({ instance: entry.instance, whitespaceHash: entry.whitespaceHash });
    byKey.set(key, instances);
    refByKey.set(key, entry.ref);
  }

  return Array.from(byKey, ([key, comparedInstances]) => {
    const ref = refByKey.get(key);
    if (!ref) throw new Error(`Missing resource ref for ${key}.`);
    comparedInstances.sort((left, right) =>
      left.instance.locationId.localeCompare(right.instance.locationId)
    );
    const instances = comparedInstances.map(({ instance }) => instance);
    return {
      ref,
      key,
      instances,
      coverage: resolveLibraryCoverage(ref, instances),
      ...describeDivergence(ref.kind, comparedInstances),
    };
  }).sort((left, right) => left.key.localeCompare(right.key));
}

export function resetLibraryDiscoveryCache(): void {
  libraryCache.clear();
}
