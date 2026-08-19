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
 *
 * Machines matter here for one reason above all others: the last-copy guard. A
 * copy surviving on another box is a surviving copy, and a guard that counted
 * only locations would either demand an acknowledgement for a resource that is
 * not disappearing, or — far worse — fail to demand one for a resource that is.
 */

import { libraryLocationsFor } from '@mangostudio/shared/app-settings';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import {
  enabledLibraryLocations,
  type LibraryInstance,
  type LibraryLocationId,
  type LibraryLocationStatus,
  type LibraryResourceRef,
  type LibraryStagedRemoval,
  type PropagationBlockedReason,
  parseResourceKey,
  type RemovalBlockedReason,
  type RemovalLocation,
  type RemovalPreview,
  type RemovalPreviewEntry,
  type RemovalPreviewRequest,
  type ResourceKind,
} from '@mangostudio/shared/library';
import {
  DIRECTORY_HASHED_RESOURCE_KINDS,
  getLibraryLocation,
  type LocationDefinition,
} from '@mangostudio/shared/library/host';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import { getDb } from '../../../db/database';
import { assertRequestedProfileId, ProfileMismatchError } from '../../../lib/profile-context';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import { LibraryRequestError } from '../domain/library-request-error';
import { createLibraryPathEnv } from '../infrastructure/location-probe';
import { findStagedRemovalsForLocations } from '../infrastructure/tree-removal';
import { compareText, hashJson, hashLibraryState } from './preview-state';
import { type EnvironmentSnapshot, readEnvironmentSnapshot } from './propagation-preview';

export interface RemovalPreviewDeps {
  /** Always a forced rescan: previewing a deletion against stale state is worse than not previewing. */
  snapshot(
    userId: string,
    environmentId: string,
    kinds: readonly ResourceKind[]
  ): Promise<EnvironmentSnapshot>;
  /** The same set the scanner honours, so a copy is never removed unseen. */
  enabledLocationIds(userId: string): Promise<ReadonlySet<LibraryLocationId>>;
  pathEnv(environmentId: string): PathEnv;
  /**
   * Interrupted-apply leftovers on one machine.
   *
   * Only Local can be walked from here — the hub shares its filesystem. A remote
   * machine reports none rather than a wrong answer: an empty list understates
   * the leftovers, while listing the hub's own would name paths that do not
   * exist there at all.
   */
  staleStagedRemovals(
    environmentId: string,
    locations: readonly LocationDefinition[],
    env: PathEnv
  ): Promise<readonly LibraryStagedRemoval[]>;
}

const defaultRemovalPreviewDeps: RemovalPreviewDeps = {
  snapshot: readEnvironmentSnapshot,
  enabledLocationIds: async (userId) =>
    enabledLibraryLocations(libraryLocationsFor(await getAppSettings(getDb(), userId)), 'home'),
  pathEnv: () => createLibraryPathEnv(),
  staleStagedRemovals: async (environmentId, locations, env) =>
    environmentId === LOCAL_ENVIRONMENT_ID
      ? await findStagedRemovalsForLocations(locations, env)
      : [],
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
  const environmentIds =
    request.environmentIds && request.environmentIds.length > 0
      ? [...new Set(request.environmentIds)]
      : [LOCAL_ENVIRONMENT_ID];

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
  const snapshots = await Promise.all(
    environmentIds.map((environmentId) => deps.snapshot(userId, environmentId, kinds))
  );

  // Present *somewhere* in scope. Requiring it on every machine would make
  // "remove this from the box that still has it" a 404.
  const requested = [...refs.keys()];
  const found = new Set(
    snapshots.flatMap((snapshot) => snapshot.resources.map((resource) => resource.key))
  );
  for (const key of requested) {
    if (!found.has(key)) {
      throw new LibraryRequestError(404, `Library resource "${key}" was not found.`);
    }
  }

  const leftovers = (
    await Promise.all(
      snapshots.map(async (snapshot) =>
        (
          await deps.staleStagedRemovals(
            snapshot.environmentId,
            locations,
            deps.pathEnv(snapshot.environmentId)
          )
        ).map((leftover) => ({ ...leftover, environmentId: snapshot.environmentId }))
      )
    )
  ).flat();

  const entries = requested.map((key) =>
    buildRemovalEntry(key, refs.get(key) as LibraryResourceRef, snapshots, locations)
  );
  const stateHash = hashLibraryState(
    snapshots.map((snapshot) => ({
      environmentId: snapshot.environmentId,
      resources: snapshot.resources,
      statuses: new Map(
        locations.flatMap((location) => {
          const status = snapshot.statuses.get(location.id);
          return status ? [[location.id, status] as const] : [];
        })
      ),
    }))
  );

  return {
    previewToken: hashJson({
      // Removal and propagation are different operations over the same inputs,
      // so their tokens must not be interchangeable even if everything else
      // about the two requests happens to match.
      operation: 'library-removal',
      profileId,
      resourceKeys: [...requested].sort(compareText),
      locationIds: locations.map((location) => location.id).sort(compareText),
      environmentIds: [...environmentIds].sort(compareText),
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

interface ClassifiedRemoval {
  readonly environmentId: string;
  readonly location: LocationDefinition;
  readonly instance: LibraryInstance | undefined;
  readonly blockedReason: RemovalBlockedReason | undefined;
}

/** One copy on one machine — the unit everything in a removal is keyed by. */
interface PlacedInstance {
  readonly environmentId: string;
  readonly instance: LibraryInstance;
  readonly directoryHashDomain: number;
}

function placementKey(environmentId: string, locationId: LibraryLocationId): string {
  return `${environmentId}\u001f${locationId}`;
}

function buildRemovalEntry(
  resourceKey: string,
  ref: LibraryResourceRef,
  snapshots: readonly EnvironmentSnapshot[],
  locations: readonly LocationDefinition[]
): RemovalPreviewEntry {
  const placed: PlacedInstance[] = snapshots.flatMap((snapshot) => {
    const resource = snapshot.resources.find((candidate) => candidate.key === resourceKey);
    return (resource?.instances ?? []).map((instance) => ({
      environmentId: snapshot.environmentId,
      instance,
      directoryHashDomain: snapshot.directoryHashDomain,
    }));
  });

  // A location stores exactly one kind, so removing a skill never offers the
  // subagent directories as places to remove it from.
  const candidates = locations.filter((location) => location.kind === ref.kind);
  const classified = snapshots.flatMap((snapshot) => {
    const resource = snapshot.resources.find((candidate) => candidate.key === resourceKey);
    const instanceByLocation = new Map(
      (resource?.instances ?? []).map((instance) => [instance.locationId, instance] as const)
    );
    return candidates.map((location): ClassifiedRemoval => {
      const instance = instanceByLocation.get(location.id);
      return {
        environmentId: snapshot.environmentId,
        location,
        instance,
        // The machine's own state comes first: a location cannot be unwritable
        // on a box nobody could reach, and naming the location's problem there
        // sends the user after the wrong thing.
        blockedReason:
          environmentBlockedReason(snapshot.blockedReason) ??
          removalBlockedReason(location, snapshot.statuses.get(location.id), instance),
      };
    });
  });

  const removing = new Set(
    classified
      .filter((row) => row.instance !== undefined && row.blockedReason === undefined)
      .map((row) => placementKey(row.environmentId, row.location.id))
  );
  const surviving = placed.filter(
    (candidate) =>
      !removing.has(placementKey(candidate.environmentId, candidate.instance.locationId))
  );
  const divergence = placed.length > 1 ? describeDivergence(placed, ref.kind) : 'single';

  return {
    resourceKey,
    ref,
    divergence,
    locations: classified.map((row) =>
      describeRemovalLocation(row, removing, placed, divergence)
    ),
    instancePlacements: placed
      .map((candidate) => ({
        environmentId: candidate.environmentId,
        locationId: candidate.instance.locationId,
      }))
      .sort(
        (left, right) =>
          compareText(left.environmentId, right.environmentId) ||
          compareText(left.locationId, right.locationId)
      ),
    // An entry offering nothing to remove cannot take a last copy with it, and
    // reporting `true` there would ask for an acknowledgement of nothing.
    wouldRemoveLastCopy: removing.size > 0 && surviving.length === 0,
  };
}

/**
 * The machine-level reasons the two catalogs share.
 *
 * A snapshot can only ever carry one of these three — every other propagation
 * reason describes a *write target*, which a removal does not have. Narrowing
 * explicitly rather than casting keeps that true if either union grows.
 */
function environmentBlockedReason(
  reason: PropagationBlockedReason | undefined
): RemovalBlockedReason | undefined {
  return reason === 'environment-offline' ||
    reason === 'environment-unsupported' ||
    reason === 'environment-readonly'
    ? reason
    : undefined;
}

/**
 * The verdict over every machine in scope, derived here rather than taken from
 * any one machine's `LibraryResource` — that field describes divergence *within*
 * a machine, and reporting it would call a resource uniform while two boxes hold
 * different bytes.
 */
function describeDivergence(
  placed: readonly PlacedInstance[],
  kind: ResourceKind
): RemovalPreviewEntry['divergence'] {
  if (DIRECTORY_HASHED_RESOURCE_KINDS.has(kind)) {
    const domains = new Set(
      placed.flatMap((candidate) =>
        candidate.instance.valid ? [candidate.directoryHashDomain] : []
      )
    );
    if (domains.size > 1) return 'incomparable';
  }
  const hashes = new Set(
    placed.flatMap((candidate) =>
      candidate.instance.valid ? [candidate.instance.contentHash] : []
    )
  );
  if (hashes.size === 0) return 'not-comparable';
  return hashes.size > 1 ? 'divergent' : 'uniform';
}

function describeRemovalLocation(
  row: ClassifiedRemoval,
  removing: ReadonlySet<string>,
  placed: readonly PlacedInstance[],
  divergence: RemovalPreviewEntry['divergence']
): RemovalLocation {
  const { location, instance, blockedReason } = row;
  const base = {
    environmentId: row.environmentId,
    locationId: location.id,
    targetIds: [...location.readBy],
    path: instance?.path ?? null,
    ...(instance?.contentHash !== undefined && { contentHash: instance.contentHash }),
    ...(instance !== undefined && { modifiedAtMs: instance.modifiedAtMs }),
  };

  if (blockedReason) {
    return { ...base, operation: 'blocked', blockedReason, eliminatesContentGroup: false };
  }
  if (!instance) {
    return { ...base, operation: 'absent', eliminatesContentGroup: false };
  }

  return {
    ...base,
    operation: 'remove',
    // Mixed directory-hash domains produce different hashes for the same bytes,
    // so a hash-keyed group would call each copy a unique version. Withhold the
    // claim until the hashes are comparable again.
    eliminatesContentGroup:
      divergence === 'incomparable'
        ? false
        : eliminatesContentGroup(instance, removing, placed),
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
  removing: ReadonlySet<string>,
  placed: readonly PlacedInstance[]
): boolean {
  if (!instance.valid) return false;
  return !placed.some(
    (candidate) =>
      candidate.instance.valid &&
      candidate.instance.contentHash === instance.contentHash &&
      !removing.has(placementKey(candidate.environmentId, candidate.instance.locationId))
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
