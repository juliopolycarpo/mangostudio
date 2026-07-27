import type { AppSettings, LibraryLocationSettings } from '@mangostudio/shared/app-settings';
import {
  type LibraryLocationId,
  type LibraryResource,
  type ResourceKind,
  resourceKey,
} from '@mangostudio/shared/library';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import type { PathEnv } from '../../../lib/path-env';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import { LIBRARY_LOCATION_DEFINITIONS } from '../domain/registry';
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
  const pathEnv = options.pathEnv ?? createLibraryPathEnv();
  const enabledLocations = enabledLibraryLocations(settings.libraryLocations);
  const kinds = options.kinds ? new Set(options.kinds) : null;
  const locations = LIBRARY_LOCATION_DEFINITIONS.flatMap((location) => {
    if (!enabledLocations.has(location.id)) return [];
    if (kinds && !kinds.has(location.kind)) return [];
    const path = options.locationPathOverrides?.[location.id] ?? location.resolvePath(pathEnv);
    return path ? [{ location, path }] : [];
  });
  const signature = locations
    .map(({ location, path }) => `${location.id}\0${path}`)
    .sort()
    .join('\n');
  const cache = options.cache ?? libraryCache;
  const force = options.force ?? false;

  return cache.getOrComputeScan(signature, (options.now ?? Date.now)(), force, async () => {
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

export function enabledLibraryLocations(
  settings: LibraryLocationSettings
): ReadonlySet<LibraryLocationId> {
  const enabled = new Set(
    Object.entries(settings).flatMap(([id, value]) => (value ? [id as LibraryLocationId] : []))
  );
  enabled.add('mango-skills');
  return enabled;
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
      ...describeDivergence(comparedInstances),
    };
  }).sort((left, right) => left.key.localeCompare(right.key));
}

export function resetLibraryDiscoveryCache(): void {
  libraryCache.clear();
}
