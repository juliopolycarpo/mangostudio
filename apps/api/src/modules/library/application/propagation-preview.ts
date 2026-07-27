/**
 * Read-only half of library propagation: force a rescan, classify what writing
 * each candidate winner into each destination would do, and hand back a token
 * plus a state hash that bind a later apply to exactly this observation.
 *
 * Modeled on `mcp-portability-service.ts` on purpose. A second, differently
 * shaped safety protocol for the same "preview, decide, apply" problem would be
 * a maintenance hazard, so the token, the state hash, and the explicit per-entry
 * decisions all keep that module's mechanics.
 */

import { createHash } from 'node:crypto';
import {
  type AdapterStrategy,
  type LibraryInstance,
  type LibraryLocationId,
  type LibraryLocationStatus,
  type LibraryResource,
  type LibraryResourceRef,
  type PropagationBlockedReason,
  type PropagationDestination,
  type PropagationOutcome,
  type PropagationPreview,
  type PropagationPreviewEntry,
  type PropagationPreviewRequest,
  type PropagationSourceGroup,
  parseResourceKey,
  type ResourceFormat,
  type ResourceKind,
  type ValidLibraryInstance,
} from '@mangostudio/shared/library';
import { getDb } from '../../../db/database';
import {
  type AdapterCatalog,
  defaultAdapterCatalog,
  rankAdapterStrategies,
} from '../domain/format-adapters';
import { PropagationRequestError } from '../domain/propagation-error';
import { getLibraryLocation, type LocationDefinition } from '../domain/registry';
import { createLibraryPathEnv, describeLocation } from '../infrastructure/location-probe';
import { acknowledgedResourceKeys } from './conflict-resolution';
import { discoverLibraryResources } from './library-discovery';

export interface PropagationPreviewDeps {
  /** Always a forced rescan: a preview of stale state is worse than no preview. */
  discover(userId: string, kinds: readonly ResourceKind[]): Promise<LibraryResource[]>;
  describeLocation(id: LibraryLocationId): LibraryLocationStatus;
  adapters: AdapterCatalog;
  /** Resources whose current divergence the user has already accepted. */
  acknowledgedKeys(
    userId: string,
    resources: readonly LibraryResource[]
  ): Promise<ReadonlySet<string>>;
}

const defaultPropagationPreviewDeps: PropagationPreviewDeps = {
  discover: (userId, kinds) => discoverLibraryResources(getDb(), userId, { force: true, kinds }),
  describeLocation: (id) => describeLocation(id, createLibraryPathEnv()),
  adapters: defaultAdapterCatalog,
  acknowledgedKeys: acknowledgedResourceKeys,
};

export async function previewLibraryPropagation(
  userId: string,
  request: PropagationPreviewRequest,
  overrides: Partial<PropagationPreviewDeps> = {}
): Promise<PropagationPreview> {
  const deps = { ...defaultPropagationPreviewDeps, ...overrides };
  const refs = parseRequestedResources(request.resourceKeys);
  const locations = parseRequestedLocations(request.targetLocationIds);

  const kinds = [...new Set([...refs.values()].map((ref) => ref.kind))];
  const discovered = await deps.discover(userId, kinds);
  const byKey = new Map(discovered.map((resource) => [resource.key, resource]));
  const resources = [...refs.keys()].map((key) => {
    const resource = byKey.get(key);
    if (!resource) {
      throw new PropagationRequestError(404, `Library resource "${key}" was not found.`);
    }
    return resource;
  });

  const statuses = new Map(
    locations.map((location) => [location.id, deps.describeLocation(location.id)] as const)
  );
  const acknowledged = await deps.acknowledgedKeys(userId, resources);
  const entries = resources.map((resource) =>
    buildPreviewEntry(resource, locations, statuses, deps.adapters, acknowledged.has(resource.key))
  );
  const stateHash = hashPropagationState(resources, statuses);

  return {
    previewToken: hashJson({
      resourceKeys: [...refs.keys()].sort(compareText),
      targetLocationIds: locations.map((location) => location.id).sort(compareText),
      stateHash,
      entries,
    }),
    stateHash,
    entries,
  };
}

/** Deduplicates while preserving request order, so the response is predictable. */
function parseRequestedResources(keys: readonly string[]): Map<string, LibraryResourceRef> {
  const refs = new Map<string, LibraryResourceRef>();
  for (const key of keys) {
    const ref = parseResourceKey(key);
    if (!ref) throw new PropagationRequestError(422, `Invalid library resource key: "${key}".`);
    refs.set(key, ref);
  }
  return refs;
}

function parseRequestedLocations(ids: readonly LibraryLocationId[]): LocationDefinition[] {
  const locations = new Map<LibraryLocationId, LocationDefinition>();
  for (const id of ids) {
    const location = getLibraryLocation(id);
    if (!location) throw new PropagationRequestError(422, `Unknown library location: "${id}".`);
    locations.set(id, location);
  }
  return [...locations.values()];
}

function buildPreviewEntry(
  resource: LibraryResource,
  locations: readonly LocationDefinition[],
  statuses: ReadonlyMap<LibraryLocationId, LibraryLocationStatus>,
  adapters: AdapterCatalog,
  acknowledgedDivergence: boolean
): PropagationPreviewEntry {
  const sourceGroups = buildSourceGroups(resource.instances);
  const instanceByLocation = new Map(
    resource.instances.map((instance) => [instance.locationId, instance] as const)
  );

  return {
    resourceKey: resource.key,
    ref: resource.ref,
    divergence: resource.divergence,
    sourceGroups,
    // Divergence is a user decision with no system-side tiebreaker (D5): more
    // than one readable version means an apply has to name the winner.
    requiresWinnerSelection: sourceGroups.length > 1,
    acknowledgedDivergence,
    destinations: locations
      // A location stores exactly one kind, so propagating a skill never even
      // offers the subagent directories as destinations.
      .filter((location) => location.kind === resource.ref.kind)
      .map((location) =>
        buildDestination(
          resource.ref,
          sourceGroups,
          location,
          statuses.get(location.id),
          instanceByLocation.get(location.id),
          adapters
        )
      ),
  };
}

/**
 * Distinct readable versions, most-replicated first. Instances the scanner could
 * not read end to end are excluded: an unreadable copy has no content to
 * propagate, and it must never present itself as a candidate winner.
 */
function buildSourceGroups(instances: readonly LibraryInstance[]): PropagationSourceGroup[] {
  const byHash = new Map<string, ValidLibraryInstance[]>();
  for (const instance of instances) {
    if (!instance.valid) continue;
    const members = byHash.get(instance.contentHash) ?? [];
    members.push(instance);
    byHash.set(instance.contentHash, members);
  }

  return [...byHash]
    .map(([contentHash, members]) => {
      const locationIds = members.map((instance) => instance.locationId).sort(compareText);
      return {
        contentHash,
        locationIds,
        instanceCount: members.length,
        formats: [...new Set(members.map((instance) => instance.format))].sort(compareText),
        newestModifiedAtMs: Math.max(...members.map((instance) => instance.modifiedAtMs)),
        // Every member holds the same bytes, so any member's size describes them all.
        sizeBytes: members[0].sizeBytes,
        contentLocationId: locationIds[0],
      };
    })
    .sort(
      (left, right) =>
        right.instanceCount - left.instanceCount || compareText(left.contentHash, right.contentHash)
    );
}

function buildDestination(
  ref: LibraryResourceRef,
  sourceGroups: readonly PropagationSourceGroup[],
  location: LocationDefinition,
  status: LibraryLocationStatus | undefined,
  current: LibraryInstance | undefined,
  adapters: AdapterCatalog
): PropagationDestination {
  const currentContentHash = current?.valid ? current.contentHash : undefined;
  const base = {
    locationId: location.id,
    targetIds: [...location.readBy],
    toFormat: location.format,
    path: status?.path ?? null,
    ...(currentContentHash !== undefined && { currentContentHash }),
  };

  const blockedReason = destinationBlockedReason(ref, location, status, current, sourceGroups);
  if (blockedReason) return { ...base, blockedReason, outcomes: [] };

  return {
    ...base,
    outcomes: sourceGroups.map((group) =>
      classifyOutcome(group, location.format, currentContentHash, adapters)
    ),
  };
}

/**
 * Reasons that hold no matter which winner the user picks. Ordered from the
 * most fundamental property of the destination to the most incidental, so the
 * reported code is the one the user would have to fix first.
 */
function destinationBlockedReason(
  ref: LibraryResourceRef,
  location: LocationDefinition,
  status: LibraryLocationStatus | undefined,
  current: LibraryInstance | undefined,
  sourceGroups: readonly PropagationSourceGroup[]
): PropagationBlockedReason | undefined {
  if (!status || status.path === null) return 'unsupported-location';
  if (location.access !== 'read-write') return 'read-only-location';
  // A single-file location is one named resource — `~/.claude/CLAUDE.md` is
  // `instruction:global` and nothing else — so any other slug has no home here.
  if (location.layout === 'single-file' && location.resourceSlug !== ref.slug) {
    return 'slug-mismatch';
  }
  if (!status.writable) return 'location-unwritable';
  if (current && !current.valid) return 'invalid-destination';
  if (sourceGroups.length === 0) return 'no-source-content';
  return undefined;
}

function classifyOutcome(
  group: PropagationSourceGroup,
  toFormat: ResourceFormat,
  currentContentHash: string | undefined,
  adapters: AdapterCatalog
): PropagationOutcome {
  // Bytes already stored in this format copy across untouched. A destination
  // that sits inside the group necessarily reaches this branch, so `noop` is
  // only ever reported for a write that would change nothing.
  if (group.formats.includes(toFormat)) {
    return {
      winnerContentHash: group.contentHash,
      operation:
        currentContentHash === group.contentHash
          ? 'noop'
          : currentContentHash === undefined
            ? 'create'
            : 'overwrite',
    };
  }

  const { fromFormat, available, recommended } = selectAdaptation(group, toFormat, adapters);
  const adaptation = {
    fromFormat,
    toFormat,
    availableStrategies: available,
    ...(recommended !== undefined && { recommendedStrategy: recommended }),
  };
  if (available.length === 0) {
    return {
      winnerContentHash: group.contentHash,
      operation: 'blocked',
      blockedReason: 'no-adapter-strategy',
      adaptation,
    };
  }
  return {
    winnerContentHash: group.contentHash,
    operation: currentContentHash === undefined ? 'adapt-create' : 'adapt-overwrite',
    adaptation,
  };
}

/**
 * Picks which of a group's formats to convert from. Groups almost always hold a
 * single format; when identical bytes are stored under two, the one an adapter
 * can actually convert wins over the first alphabetically.
 */
function selectAdaptation(
  group: PropagationSourceGroup,
  toFormat: ResourceFormat,
  adapters: AdapterCatalog
): { fromFormat: ResourceFormat; available: AdapterStrategy[]; recommended?: AdapterStrategy } {
  for (const fromFormat of group.formats) {
    const { available, recommended } = rankAdapterStrategies(
      adapters.strategiesFor(fromFormat, toFormat)
    );
    if (available.length > 0) {
      return { fromFormat, available, ...(recommended !== undefined && { recommended }) };
    }
  }
  return { fromFormat: group.formats[0] ?? toFormat, available: [] };
}

/**
 * Covers every source instance and every destination's observable state. An
 * apply re-derives this and refuses to run when it differs, so a file the user
 * edited in another window between preview and apply is never silently clobbered.
 */
function hashPropagationState(
  resources: readonly LibraryResource[],
  statuses: ReadonlyMap<LibraryLocationId, LibraryLocationStatus>
): string {
  return hashJson({
    resources: resources
      .map((resource) => ({
        key: resource.key,
        instances: resource.instances
          .map((instance) => ({
            locationId: instance.locationId,
            path: instance.path,
            valid: instance.valid,
            contentHash: instance.contentHash ?? null,
            sizeBytes: instance.sizeBytes ?? null,
            modifiedAtMs: instance.modifiedAtMs,
          }))
          .sort((left, right) => compareText(left.locationId, right.locationId)),
      }))
      .sort((left, right) => compareText(left.key, right.key)),
    locations: [...statuses.values()]
      .map((status) => ({
        id: status.id,
        path: status.path,
        exists: status.exists,
        writable: status.writable,
        access: status.access,
      }))
      .sort((left, right) => compareText(left.id, right.id)),
  });
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/** Locale-independent so a token computed here matches one computed anywhere. */
function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
