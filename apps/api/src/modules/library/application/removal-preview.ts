/**
 * Read-only half of library removal: force a rescan, classify what removing
 * each copy would do, and hand back a token plus a state hash that bind a later
 * apply to exactly this observation.
 *
 * It borrows propagation's entire safety protocol and inverts one thing — the
 * verb. Propagation asks which content wins; this asks which copies go. What
 * removal needs of its own is a different default posture, because the failure
 * mode is not symmetric: an overwrite's backup restores a path that still
 * exists, while a removal's backup is the only remaining copy.
 */

import { libraryLocationsFor } from '@mangostudio/shared/app-settings';
import {
  enabledLibraryLocations,
  getLibraryLocation,
  type LibraryInstance,
  type LibraryLocationId,
  type LibraryLocationStatus,
  type LibraryResource,
  type LibraryResourceRef,
  type LocationDefinition,
  parseResourceKey,
  type RemovalBlockedReason,
  type RemovalLocation,
  type RemovalPreview,
  type RemovalPreviewEntry,
  type RemovalPreviewRequest,
  type ResourceKind,
  type StagedRemovalLeftover,
} from '@mangostudio/shared/library';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import { getDb } from '../../../db/database';
import { assertRequestedProfileId, ProfileMismatchError } from '../../../lib/profile-context';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import { LibraryRequestError } from '../domain/library-request-error';
import { createLibraryPathEnv, describeLocation } from '../infrastructure/location-probe';
import { findStagedRemovalsForLocations } from '../infrastructure/tree-removal';
import { discoverLibraryResources } from './library-discovery';
import { compareText, hashJson, hashLibraryState } from './preview-state';

export interface RemovalPreviewDeps {
  /** Always a forced rescan: previewing a deletion against stale state is worse than not previewing. */
  discover(userId: string, kinds: readonly ResourceKind[]): Promise<LibraryResource[]>;
  describeLocation(id: LibraryLocationId): LibraryLocationStatus;
  /** The same set the scanner honours, so a copy is never removed unseen. */
  enabledLocationIds(userId: string): Promise<ReadonlySet<LibraryLocationId>>;
  pathEnv(): PathEnv;
  staleStagedRemovals(
    locations: readonly LocationDefinition[],
    env: PathEnv
  ): Promise<readonly StagedRemovalLeftover[]>;
}

const defaultRemovalPreviewDeps: RemovalPreviewDeps = {
  discover: (userId, kinds) => discoverLibraryResources(getDb(), userId, { force: true, kinds }),
  describeLocation: (id) => describeLocation(id, createLibraryPathEnv()),
  enabledLocationIds: async (userId) =>
    enabledLibraryLocations(libraryLocationsFor(await getAppSettings(getDb(), userId)), 'home'),
  pathEnv: () => createLibraryPathEnv(),
  staleStagedRemovals: findStagedRemovalsForLocations,
};

export async function previewLibraryRemoval(
  userId: string,
  request: RemovalPreviewRequest,
  overrides: Partial<RemovalPreviewDeps> = {}
): Promise<RemovalPreview> {
  const deps = { ...defaultRemovalPreviewDeps, ...overrides };
  let profileId: string;
  try {
    profileId = assertRequestedProfileId(request.profileId, { userId });
  } catch (error) {
    if (error instanceof ProfileMismatchError) {
      throw new LibraryRequestError(400, error.message);
    }
    throw error;
  }

  const refs = parseRequestedResources(request.resourceKeys);
  const locations = parseRequestedLocations(request.locationIds);

  // The scanner skips disabled locations, so their copies never appear in
  // `discovered`. Previewing one would report every copy there as `absent` —
  // the exact reading under which a removal looks safe when it is not.
  const enabled = await deps.enabledLocationIds(userId);
  for (const location of locations) {
    if (!enabled.has(location.id)) {
      throw new LibraryRequestError(
        422,
        `Library location "${location.id}" is not enabled, so its contents cannot be previewed or removed.`
      );
    }
  }

  const kinds = [...new Set([...refs.values()].map((ref) => ref.kind))];
  const discovered = await deps.discover(userId, kinds);
  const byKey = new Map(discovered.map((resource) => [resource.key, resource]));
  const resources = [...refs.keys()].map((key) => {
    const resource = byKey.get(key);
    if (!resource) {
      throw new LibraryRequestError(404, `Library resource "${key}" was not found.`);
    }
    return resource;
  });

  const statuses = new Map(
    locations.map((location) => [location.id, deps.describeLocation(location.id)] as const)
  );
  const env = deps.pathEnv();
  const leftovers = await deps.staleStagedRemovals(locations, env);

  const entries = resources.map((resource) => buildRemovalEntry(resource, locations, statuses));
  const stateHash = hashLibraryState(resources, statuses);

  return {
    previewToken: hashJson({
      // Removal and propagation are different operations over the same inputs,
      // so their tokens must not be interchangeable even if everything else
      // about the two requests happens to match.
      operation: 'library-removal',
      profileId,
      resourceKeys: [...refs.keys()].sort(compareText),
      locationIds: locations.map((location) => location.id).sort(compareText),
      stateHash,
      entries,
    }),
    stateHash,
    entries,
    staleStagedRemovals: [...leftovers],
  };
}

/** Deduplicates while preserving request order, so the response is predictable. */
function parseRequestedResources(keys: readonly string[]): Map<string, LibraryResourceRef> {
  const refs = new Map<string, LibraryResourceRef>();
  for (const key of keys) {
    const ref = parseResourceKey(key);
    if (!ref) throw new LibraryRequestError(422, `Invalid library resource key: "${key}".`);
    refs.set(key, ref);
  }
  return refs;
}

function parseRequestedLocations(ids: readonly LibraryLocationId[]): LocationDefinition[] {
  const locations = new Map<LibraryLocationId, LocationDefinition>();
  for (const id of ids) {
    const location = getLibraryLocation(id);
    if (!location) throw new LibraryRequestError(422, `Unknown library location: "${id}".`);
    locations.set(id, location);
  }
  return [...locations.values()];
}

function buildRemovalEntry(
  resource: LibraryResource,
  locations: readonly LocationDefinition[],
  statuses: ReadonlyMap<LibraryLocationId, LibraryLocationStatus>
): RemovalPreviewEntry {
  const instanceByLocation = new Map(
    resource.instances.map((instance) => [instance.locationId, instance] as const)
  );
  // A location stores exactly one kind, so removing a skill never offers the
  // subagent directories as places to remove it from.
  const candidates = locations.filter((location) => location.kind === resource.ref.kind);

  const classified = candidates.map((location) => {
    const instance = instanceByLocation.get(location.id);
    const blockedReason = removalBlockedReason(location, statuses.get(location.id), instance);
    return { location, instance, blockedReason };
  });

  const removing = new Set(
    classified
      .filter((row) => row.instance !== undefined && row.blockedReason === undefined)
      .map((row) => row.location.id)
  );
  const surviving = resource.instances.filter((instance) => !removing.has(instance.locationId));

  return {
    resourceKey: resource.key,
    ref: resource.ref,
    divergence: resource.divergence,
    locations: classified.map((row) => describeRemovalLocation(row, removing, resource.instances)),
    instanceLocationIds: resource.instances
      .map((instance) => instance.locationId)
      .sort(compareText),
    // An entry offering nothing to remove cannot take a last copy with it, and
    // reporting `true` there would ask for an acknowledgement of nothing.
    wouldRemoveLastCopy: removing.size > 0 && surviving.length === 0,
  };
}

function describeRemovalLocation(
  row: {
    readonly location: LocationDefinition;
    readonly instance: LibraryInstance | undefined;
    readonly blockedReason: RemovalBlockedReason | undefined;
  },
  removing: ReadonlySet<LibraryLocationId>,
  instances: readonly LibraryInstance[]
): RemovalLocation {
  const { location, instance, blockedReason } = row;
  const base = {
    locationId: location.id,
    targetIds: [...location.readBy],
    path: instance?.path ?? null,
    ...(instance?.contentHash !== undefined && { contentHash: instance.contentHash }),
    ...(instance !== undefined && { modifiedAtMs: instance.modifiedAtMs }),
  };

  if (!instance) {
    return { ...base, operation: 'absent', eliminatesContentGroup: false };
  }
  if (blockedReason) {
    return { ...base, operation: 'blocked', blockedReason, eliminatesContentGroup: false };
  }

  return {
    ...base,
    operation: 'remove',
    eliminatesContentGroup: eliminatesContentGroup(instance, removing, instances),
  };
}

/**
 * True when no copy of this instance's version would survive the removals on
 * offer. Divergent copies are not interchangeable, and removing the minority
 * group can be removing the newest work — the row says which of the two the
 * user is doing rather than refusing to let them do it.
 */
function eliminatesContentGroup(
  instance: LibraryInstance,
  removing: ReadonlySet<LibraryLocationId>,
  instances: readonly LibraryInstance[]
): boolean {
  if (!instance.valid) return false;
  return !instances.some(
    (candidate) =>
      candidate.valid &&
      candidate.contentHash === instance.contentHash &&
      !removing.has(candidate.locationId)
  );
}

/**
 * Ordered from the most fundamental property of the location to the most
 * incidental, so the reported code is the one the user would have to fix first.
 * An instance the scanner could not read is last and still blocks: it cannot be
 * backed up faithfully, so removing it would be a deletion with no undo (G2).
 */
function removalBlockedReason(
  location: LocationDefinition,
  status: LibraryLocationStatus | undefined,
  instance: LibraryInstance | undefined
): RemovalBlockedReason | undefined {
  if (!instance) return undefined;
  if (!status || status.path === null) return 'unsupported-location';
  if (location.access !== 'read-write') return 'read-only-location';
  if (!status.writable) return 'location-unwritable';
  if (!instance.valid) return 'invalid-instance';
  return undefined;
}
