import {
  type LibraryCache,
  type ReadLibraryInstance,
  resolveLibraryScanTargets,
  scanLibraryInstancesForPathEnv,
} from '@mangostudio/runtime';
import type { AppSettings } from '@mangostudio/shared/app-settings';
import { libraryLocationsFor } from '@mangostudio/shared/app-settings';
import {
  type LibraryLocationId,
  type LibraryResource,
  type LibraryScanResult,
  type ResourceKind,
  resourceKey,
} from '@mangostudio/shared/library';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import { hubLibraryDiscoveryCache } from '../infrastructure/library-cache';
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
): Promise<LibraryScanResult> {
  const settings = options.settings ?? (await getAppSettings(db, userId));
  return discoverLibraryResourcesFromSettings(settings, options);
}

/**
 * Discover library resources without a database when settings are already known
 * (CLI, tests). Scanning runs through the runtime engine; coverage and
 * divergence stay here as pure decisions over the scan result.
 */
export function discoverLibraryResourcesFromSettings(
  settings: AppSettings,
  options: Omit<LibraryDiscoveryOptions, 'settings'> = {}
): Promise<LibraryScanResult> {
  const pathEnv = options.pathEnv ?? createLibraryPathEnv();
  const cache = options.cache ?? hubLibraryDiscoveryCache;
  const force = options.force ?? false;
  const locationSettings = libraryLocationsFor(settings);
  const targets = resolveLibraryScanTargets(locationSettings, pathEnv, {
    kinds: options.kinds,
    locationPathOverrides: options.locationPathOverrides,
  });
  // The runtime scan builds the same target list under a `flat:` prefix. The
  // prefixes are what keep the two apart when they share one cache instance:
  // this memo holds grouped `LibraryResource[]`, that one holds flat entries.
  const signature = `grouped:\n${targets
    .map((target) => `${target.scope}\0${target.locationId}\0${target.path}`)
    .sort()
    .join('\n')}`;

  return cache.getOrComputeScan(
    signature,
    (options.now ?? Date.now)(),
    force,
    async (): Promise<LibraryScanResult> => {
      const scanned = await scanLibraryInstancesForPathEnv(locationSettings, pathEnv, {
        force,
        now: options.now,
        cache,
        kinds: options.kinds,
        locationPathOverrides: options.locationPathOverrides,
        cacheScan: false,
      });
      return {
        resources: groupResources(scanned.instances),
        unreadableEntries: [...scanned.unreadableEntries],
      };
    }
  );
}

function groupResources(scanned: readonly ReadLibraryInstance[]): LibraryResource[] {
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

/** Groups a runtime scan result the same way Local discovery does. */
export function groupLibraryScanEntries(
  scanned: readonly ReadLibraryInstance[]
): LibraryResource[] {
  return groupResources(scanned);
}

export function resetLibraryDiscoveryCache(): void {
  hubLibraryDiscoveryCache.clear();
}
