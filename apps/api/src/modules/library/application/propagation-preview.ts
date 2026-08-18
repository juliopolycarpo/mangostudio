/**
 * Read-only half of library propagation: force a rescan on every machine in
 * scope, classify what writing each candidate winner into each destination would
 * do, and hand back a token plus a state hash that bind a later apply to exactly
 * this observation.
 *
 * Modeled on `mcp-portability-service.ts` on purpose. A second, differently
 * shaped safety protocol for the same "preview, decide, apply" problem would be
 * a maintenance hazard, so the token, the state hash, and the explicit per-entry
 * decisions all keep that module's mechanics.
 *
 * A destination is a machine *and* a location. Divergence across machines reads
 * exactly like divergence across locations — no canonical copy, the user picks
 * the winner — which is the peer model applied one dimension out. A machine that
 * cannot be reached still appears, with every destination on it blocked and a
 * reason: a picker that silently omits a machine looks like one that does not
 * have it.
 */

import { libraryLocationsFor } from '@mangostudio/shared/app-settings';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import {
  type AdapterStrategy,
  enabledLibraryLocations,
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
import { getLibraryLocation, type LocationDefinition } from '@mangostudio/shared/library/host';
import { getDb } from '../../../db/database';
import { assertRequestedProfileId, ProfileMismatchError } from '../../../lib/profile-context';
import { getRuntimeClient } from '../../../services/runtime-client';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import {
  type AdapterCatalog,
  defaultAdapterCatalog,
  rankAdapterStrategies,
} from '../domain/format-adapters';
import { LibraryRequestError } from '../domain/library-request-error';
import { isAgentStrategyAvailable } from './adapters/agent-strategy';
import { acknowledgedResourceKeys } from './conflict-resolution';
import { environmentLibraryService } from './environment-library-service';
import { compareText, hashJson, hashLibraryState, type LibraryStateSlice } from './preview-state';

/**
 * Everything one machine contributes: what it holds, and what its locations look
 * like right now. A machine that could not be scanned carries a blocked reason
 * instead — it has no instances to offer and no destination that can be
 * classified, but it is still part of the answer.
 */
export interface EnvironmentSnapshot {
  readonly environmentId: string;
  /** Set when nothing on this machine can be written; every destination inherits it. */
  readonly blockedReason?: PropagationBlockedReason;
  /** Empty when the machine could not be scanned at all. */
  readonly resources: readonly LibraryResource[];
  readonly statuses: ReadonlyMap<LibraryLocationId, LibraryLocationStatus>;
}

export interface PropagationPreviewDeps {
  /** Always a forced rescan: a preview of stale state is worse than no preview. */
  snapshot(
    userId: string,
    environmentId: string,
    kinds: readonly ResourceKind[]
  ): Promise<EnvironmentSnapshot>;
  adapters: AdapterCatalog;
  /** Model-backed adapters disappear from the catalog when no connector is ready. */
  agentAvailable(userId: string): Promise<boolean>;
  /** Resources whose current divergence the user has already accepted. */
  acknowledgedKeys(
    userId: string,
    resources: readonly LibraryResource[]
  ): Promise<ReadonlySet<string>>;
  /** The same set the scanner honours, so a destination is never written blind. */
  enabledLocationIds(userId: string): Promise<ReadonlySet<LibraryLocationId>>;
}

/**
 * Reads one machine, turning every way it can fail to answer into a stable code.
 *
 * Failure is per machine and never fatal to the request: a two-machine
 * propagation whose second machine is asleep is still a perfectly good one-
 * machine propagation, and refusing the whole preview would make an unrelated
 * outage look like the feature is broken.
 */
export async function readEnvironmentSnapshot(
  userId: string,
  environmentId: string,
  kinds: readonly ResourceKind[]
): Promise<EnvironmentSnapshot> {
  const empty = new Map<LibraryLocationId, LibraryLocationStatus>();
  let client: Awaited<ReturnType<typeof getRuntimeClient>>;
  try {
    client = await getRuntimeClient(userId, environmentId);
  } catch {
    return { environmentId, blockedReason: 'environment-offline', resources: [], statuses: empty };
  }
  if (!client.manifest.features.library) {
    return {
      environmentId,
      blockedReason: 'environment-unsupported',
      resources: [],
      statuses: empty,
    };
  }

  const scope = { userId, environmentId };
  const db = getDb();
  let resources: LibraryResource[];
  let locations: LibraryLocationStatus[];
  try {
    const [scan, discoveredLocations] = await Promise.all([
      environmentLibraryService.discover(db, scope, { force: true, kinds }),
      environmentLibraryService.listLocations(db, scope),
    ]);
    resources = scan.resources;
    locations = discoveredLocations;
  } catch {
    return { environmentId, blockedReason: 'environment-offline', resources: [], statuses: empty };
  }

  return {
    environmentId,
    // A readonly machine is still a perfectly good *source*: it is scanned, its
    // copies compete to be the winner, and only writing to it is refused. 019
    // would refuse `library.apply` there anyway; saying so while reviewing turns
    // a mid-apply refusal into a policy the user can see before deciding.
    ...(client.manifest.features.fsWrite === false && {
      blockedReason: 'environment-readonly' as const,
    }),
    resources,
    statuses: new Map(locations.map((status) => [status.id, status])),
  };
}

const defaultPropagationPreviewDeps: PropagationPreviewDeps = {
  snapshot: readEnvironmentSnapshot,
  adapters: defaultAdapterCatalog,
  agentAvailable: isAgentStrategyAvailable,
  acknowledgedKeys: acknowledgedResourceKeys,
  enabledLocationIds: async (userId) =>
    // Every propagation destination is home-scoped: v1 defines no workspace
    // location, and writing into a repository is a consent question this seam
    // deliberately does not answer.
    enabledLibraryLocations(libraryLocationsFor(await getAppSettings(getDb(), userId)), 'home'),
};

export async function previewLibraryPropagation(
  userId: string,
  request: PropagationPreviewRequest,
  overrides: Partial<PropagationPreviewDeps> = {}
): Promise<PropagationPreview> {
  const deps = { ...defaultPropagationPreviewDeps, ...overrides };
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
  const locations = parseRequestedLocations(request.targetLocationIds);
  const environmentIds = parseRequestedEnvironments(request.environmentIds);

  // A location the scanner skips has no instances in the snapshots, so every
  // destination there would classify as `create` and the apply would overwrite
  // whatever is really on disk — and the state hash would not cover it either.
  // Refusing the request is the only honest answer.
  const enabled = await deps.enabledLocationIds(userId);
  for (const location of locations) {
    if (!enabled.has(location.id)) {
      throw new LibraryRequestError(
        422,
        `Library location "${location.id}" is not enabled, so its contents cannot be previewed or written.`
      );
    }
  }

  const kinds = [...new Set([...refs.values()].map((ref) => ref.kind))];
  const snapshots = await Promise.all(
    environmentIds.map((environmentId) => deps.snapshot(userId, environmentId, kinds))
  );

  // A resource has to exist *somewhere* in scope. Requiring it on every machine
  // would make "copy this skill to the box that does not have it yet" — the
  // whole point of the feature — a 404.
  const requested = [...refs.keys()];
  const found = new Set(
    snapshots.flatMap((snapshot) => snapshot.resources.map((resource) => resource.key))
  );
  for (const key of requested) {
    if (!found.has(key)) {
      throw new LibraryRequestError(404, `Library resource "${key}" was not found.`);
    }
  }

  const [acknowledged, agentAvailable] = await Promise.all([
    deps.acknowledgedKeys(
      userId,
      snapshots.flatMap((snapshot) => [...snapshot.resources])
    ),
    deps.agentAvailable(userId),
  ]);

  const entries = requested.map((key) =>
    buildPreviewEntry(
      key,
      refs.get(key) as LibraryResourceRef,
      snapshots,
      locations,
      deps.adapters,
      acknowledged.has(key),
      agentAvailable
    )
  );
  const stateHash = hashLibraryState(
    snapshots.map(
      (snapshot): LibraryStateSlice => ({
        environmentId: snapshot.environmentId,
        resources: snapshot.resources,
        // Only the locations this preview looked at: hashing every location a
        // machine reports would make an unrelated directory appearing elsewhere
        // invalidate a preview that never mentioned it.
        statuses: new Map(
          locations.flatMap((location) => {
            const status = snapshot.statuses.get(location.id);
            return status ? [[location.id, status] as const] : [];
          })
        ),
      })
    )
  );

  return {
    previewToken: hashJson({
      profileId,
      resourceKeys: [...requested].sort(compareText),
      targetLocationIds: locations.map((location) => location.id).sort(compareText),
      environmentIds: [...environmentIds].sort(compareText),
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

/**
 * Machines in scope, deduplicated, order preserved. Omitting the field means
 * Local alone — the only thing a client written before machines were selectable
 * could have meant.
 */
function parseRequestedEnvironments(ids: readonly string[] | undefined): string[] {
  if (!ids || ids.length === 0) return [LOCAL_ENVIRONMENT_ID];
  return [...new Set(ids)];
}

function buildPreviewEntry(
  resourceKey: string,
  ref: LibraryResourceRef,
  snapshots: readonly EnvironmentSnapshot[],
  locations: readonly LocationDefinition[],
  adapters: AdapterCatalog,
  acknowledgedDivergence: boolean,
  agentAvailable: boolean
): PropagationPreviewEntry {
  const perEnvironment = snapshots.map((snapshot) => ({
    snapshot,
    resource: snapshot.resources.find((candidate) => candidate.key === resourceKey),
  }));
  const sourceGroups = buildSourceGroups(
    perEnvironment.flatMap(({ snapshot, resource }) =>
      (resource?.instances ?? []).map((instance) => ({
        environmentId: snapshot.environmentId,
        instance,
      }))
    )
  );

  return {
    resourceKey,
    ref,
    divergence: describeDivergence(sourceGroups),
    sourceGroups,
    // Divergence is a user decision with no system-side tiebreaker (D5): more
    // than one readable version means an apply has to name the winner. Across
    // machines this is the common case rather than the exception — that is what
    // propagating between machines is for.
    requiresWinnerSelection: sourceGroups.length > 1,
    acknowledgedDivergence,
    destinations: perEnvironment.flatMap(({ snapshot, resource }) => {
      const instanceByLocation = new Map(
        (resource?.instances ?? []).map((instance) => [instance.locationId, instance] as const)
      );
      return (
        locations
          // A location stores exactly one kind, so propagating a skill never even
          // offers the subagent directories as destinations.
          .filter((location) => location.kind === ref.kind)
          .map((location) =>
            buildDestination(
              ref,
              snapshot,
              sourceGroups,
              location,
              snapshot.statuses.get(location.id),
              instanceByLocation.get(location.id),
              adapters,
              agentAvailable
            )
          )
      );
    }),
  };
}

/**
 * The verdict over every machine in scope.
 *
 * Derived here rather than taken from any one machine's `LibraryResource`: that
 * field describes divergence *within* a machine, and reporting it for a
 * cross-machine entry would call a resource uniform while two boxes hold
 * different bytes.
 */
function describeDivergence(
  sourceGroups: readonly PropagationSourceGroup[]
): PropagationPreviewEntry['divergence'] {
  if (sourceGroups.length > 1) return 'divergent';
  if (sourceGroups.length === 0) return 'single';
  return sourceGroups[0].instanceCount > 1 ? 'uniform' : 'single';
}

interface PlacedInstance {
  readonly environmentId: string;
  readonly instance: LibraryInstance;
}

/**
 * Distinct readable versions across every machine, most-replicated first.
 * Instances the scanner could not read end to end are excluded: an unreadable
 * copy has no content to propagate, and it must never present itself as a
 * candidate winner.
 */
function buildSourceGroups(placed: readonly PlacedInstance[]): PropagationSourceGroup[] {
  const byHash = new Map<string, { environmentId: string; instance: ValidLibraryInstance }[]>();
  for (const { environmentId, instance } of placed) {
    if (!instance.valid) continue;
    const members = byHash.get(instance.contentHash) ?? [];
    members.push({ environmentId, instance });
    byHash.set(instance.contentHash, members);
  }

  return [...byHash]
    .map(([contentHash, members]) => {
      // Deterministic winner-source: sorting by machine then location means two
      // previews of the same disks name the same copy to read the bytes from.
      const ordered = [...members].sort(
        (left, right) =>
          compareText(left.environmentId, right.environmentId) ||
          compareText(left.instance.locationId, right.instance.locationId)
      );
      const source = ordered[0];
      return {
        contentHash,
        locationIds: [...new Set(ordered.map((member) => member.instance.locationId))].sort(
          compareText
        ),
        environmentIds: [...new Set(ordered.map((member) => member.environmentId))].sort(
          compareText
        ),
        instanceCount: ordered.length,
        formats: [...new Set(ordered.map((member) => member.instance.format))].sort(compareText),
        newestModifiedAtMs: Math.max(...ordered.map((member) => member.instance.modifiedAtMs)),
        // Every member holds the same bytes, so any member's size describes them all.
        sizeBytes: ordered[0].instance.sizeBytes,
        contentLocationId: source.instance.locationId,
        contentPath: source.instance.path,
        contentEnvironmentId: source.environmentId,
      };
    })
    .sort(
      (left, right) =>
        right.instanceCount - left.instanceCount || compareText(left.contentHash, right.contentHash)
    );
}

function buildDestination(
  ref: LibraryResourceRef,
  snapshot: EnvironmentSnapshot,
  sourceGroups: readonly PropagationSourceGroup[],
  location: LocationDefinition,
  status: LibraryLocationStatus | undefined,
  current: LibraryInstance | undefined,
  adapters: AdapterCatalog,
  agentAvailable: boolean
): PropagationDestination {
  const currentContentHash = current?.valid ? current.contentHash : undefined;
  const base = {
    environmentId: snapshot.environmentId,
    locationId: location.id,
    targetIds: [...location.readBy],
    toFormat: location.format,
    path: status?.path ?? null,
    ...(currentContentHash !== undefined && { currentContentHash }),
  };

  // The machine's own state comes first: a location cannot be unsupported or
  // unwritable on a box nobody could reach, and reporting the location's
  // problem there would send the user to fix the wrong thing.
  const blockedReason =
    snapshot.blockedReason ??
    destinationBlockedReason(ref, location, status, current, sourceGroups);
  if (blockedReason) return { ...base, blockedReason, outcomes: [] };

  return {
    ...base,
    outcomes: sourceGroups.map((group) =>
      classifyOutcome(ref.kind, group, location, currentContentHash, adapters, agentAvailable)
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
  kind: ResourceKind,
  group: PropagationSourceGroup,
  destination: LocationDefinition,
  currentContentHash: string | undefined,
  adapters: AdapterCatalog,
  agentAvailable: boolean
): PropagationOutcome {
  const toFormat = destination.format;
  // Destination already holds the group's winning bytes — skip format work.
  if (currentContentHash === group.contentHash) {
    return {
      winnerContentHash: group.contentHash,
      operation: 'noop',
    };
  }
  const sameFormat = group.formats.find((format) => format === toFormat);
  if (
    sameFormat &&
    adapters
      .strategiesFor({
        kind,
        from: sameFormat,
        to: toFormat,
        sourceLocationId: group.contentLocationId,
        targetLocationId: destination.id,
        agentAvailable,
      })
      .includes('verbatim')
  ) {
    return {
      winnerContentHash: group.contentHash,
      operation: currentContentHash === undefined ? 'create' : 'overwrite',
    };
  }

  const { fromFormat, available, recommended } = selectAdaptation(
    kind,
    group,
    destination,
    adapters,
    agentAvailable
  );
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
  kind: ResourceKind,
  group: PropagationSourceGroup,
  destination: LocationDefinition,
  adapters: AdapterCatalog,
  agentAvailable: boolean
): { fromFormat: ResourceFormat; available: AdapterStrategy[]; recommended?: AdapterStrategy } {
  for (const fromFormat of group.formats) {
    const { available, recommended } = rankAdapterStrategies(
      adapters.strategiesFor({
        kind,
        from: fromFormat,
        to: destination.format,
        sourceLocationId: group.contentLocationId,
        targetLocationId: destination.id,
        agentAvailable,
      })
    );
    if (available.length > 0) {
      return { fromFormat, available, ...(recommended !== undefined && { recommended }) };
    }
  }
  return { fromFormat: group.formats[0] ?? destination.format, available: [] };
}
