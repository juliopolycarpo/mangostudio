/**
 * Pure presentation logic for the library surface.
 *
 * Deliberately free of React so the rules that carry the most meaning — which
 * glyph a cell earns, what counts as divergent, what is merely shadowed — can
 * be asserted directly instead of through a rendered tree.
 *
 * The vocabulary here never says "missing". A resource Cursor does not have is
 * `absent`, and absent is frequently the correct state; calling it missing would
 * push people into propagating things they never wanted everywhere.
 */

import type {
  LibraryContentGroup,
  LibraryCoverage,
  LibraryInstance,
  LibraryLocationId,
  LibraryLocationStatus,
  LibraryResource,
  LibraryTargetId,
  ResourceKind,
  ValidLibraryInstance,
} from '@mangostudio/shared/library';

/**
 * What one matrix cell says about one target.
 *
 * `shadowed` and `divergent` stay separate on purpose: two identical copies in
 * two of a target's locations are fine, two different copies are the thing to
 * look at, and merging them into one warning would hide the difference.
 */
export type CoverageCellState = 'present' | 'absent' | 'shadowed' | 'divergent' | 'only-here';

/** Characters carrying each state. Never the only signal — every cell is also labelled. */
export const CELL_GLYPHS: Readonly<Record<CoverageCellState, string>> = {
  present: '✓',
  absent: '—',
  shadowed: '⧉',
  divergent: '⚠',
  'only-here': '★',
};

export interface CoverageCell {
  readonly targetId: LibraryTargetId;
  readonly state: CoverageCellState;
  readonly effectiveLocationId?: LibraryLocationId;
  readonly shadowedLocationIds: readonly LibraryLocationId[];
  /** Hash held at the effective location, absent when that copy is unreadable. */
  readonly contentHash?: string;
  readonly path?: string;
  readonly modifiedAtMs?: number;
}

/** First characters of a content hash — enough to tell two versions apart on screen. */
export function hashPrefix(contentHash: string, length = 6): string {
  return contentHash.slice(0, length);
}

function instanceAt(
  resource: LibraryResource,
  locationId: LibraryLocationId | undefined
): LibraryInstance | undefined {
  if (locationId === undefined) return undefined;
  return resource.instances.find((instance) => instance.locationId === locationId);
}

/**
 * The hash a majority of copies agree on, or null when there is no majority —
 * either because every copy agrees already, or because the largest two groups
 * are the same size and nothing can claim to be the common version.
 *
 * A null here means "no version is the norm", which is the honest reading of a
 * two-versus-two split and keeps the UI from implying one side is canonical.
 */
export function majorityContentHash(contentGroups: readonly LibraryContentGroup[]): string | null {
  if (contentGroups.length < 2) return null;
  // The contract orders groups most-replicated first, so a tie for first place
  // is visible from the first two entries alone.
  if (contentGroups[0].instanceCount === contentGroups[1].instanceCount) return null;
  return contentGroups[0].contentHash;
}

/**
 * Resolves one cell of the coverage matrix.
 *
 * Order matters. A target whose own two locations disagree is divergent before
 * it is shadowed, and divergence outranks `only-here` because a single-target
 * resource that contradicts itself is still the actionable case.
 *
 * // Usage: const cell = coverageCell(resource, coverage);
 */
export function coverageCell(resource: LibraryResource, coverage: LibraryCoverage): CoverageCell {
  const effective = instanceAt(resource, coverage.effectiveLocationId);
  const base = {
    targetId: coverage.targetId,
    shadowedLocationIds: coverage.shadowedLocationIds,
    ...(coverage.effectiveLocationId !== undefined && {
      effectiveLocationId: coverage.effectiveLocationId,
    }),
    ...(effective?.contentHash !== undefined && { contentHash: effective.contentHash }),
    ...(effective !== undefined && { path: effective.path, modifiedAtMs: effective.modifiedAtMs }),
  };

  if (coverage.state === 'absent') return { ...base, state: 'absent' };

  const localHashes = new Set(
    [coverage.effectiveLocationId, ...coverage.shadowedLocationIds]
      .map((locationId) => instanceAt(resource, locationId)?.contentHash)
      .filter((hash): hash is string => hash !== undefined)
  );
  // This target reads two locations that hold different bytes: which one wins is
  // a precedence rule the user probably does not have in mind.
  if (localHashes.size > 1) return { ...base, state: 'divergent' };

  if (resource.contentGroups.length > 1 && effective?.contentHash !== undefined) {
    const majority = majorityContentHash(resource.contentGroups);
    if (majority === null || effective.contentHash !== majority) {
      return { ...base, state: 'divergent' };
    }
  }

  if (presentTargetCount(resource) === 1) return { ...base, state: 'only-here' };
  if (coverage.state === 'shadowed') return { ...base, state: 'shadowed' };
  return { ...base, state: 'present' };
}

/** How many targets read at least one copy. One means the resource lives in exactly one world. */
export function presentTargetCount(resource: LibraryResource): number {
  return resource.coverage.filter((coverage) => coverage.state !== 'absent').length;
}

export function coverageCells(resource: LibraryResource): CoverageCell[] {
  return resource.coverage.map((coverage) => coverageCell(resource, coverage));
}

export interface TargetCoverageSummary {
  readonly targetId: LibraryTargetId;
  /** Resources this target reads at least one copy of. */
  readonly present: number;
  /** Of those, the ones it reads at a version the rest do not agree on. */
  readonly divergent: number;
}

/**
 * The matrix collapsed to one line per target, for surfaces with no room for a
 * grid. Divergent rows are counted inside `present` rather than beside it: a
 * divergent copy is a copy the target reads, and splitting the two would make
 * the numbers stop adding up to what the matrix shows.
 */
export function summarizeCoverageByTarget(
  resources: readonly LibraryResource[],
  targetIds: readonly LibraryTargetId[]
): TargetCoverageSummary[] {
  const present = new Map<LibraryTargetId, number>();
  const divergent = new Map<LibraryTargetId, number>();

  for (const resource of resources) {
    for (const cell of coverageCells(resource)) {
      if (cell.state === 'absent') continue;
      present.set(cell.targetId, (present.get(cell.targetId) ?? 0) + 1);
      if (cell.state === 'divergent') {
        divergent.set(cell.targetId, (divergent.get(cell.targetId) ?? 0) + 1);
      }
    }
  }

  // Driven by the target registry, not by the rows: a target that reads nothing
  // is a real answer, and dropping its line would read as "not supported".
  return targetIds.map((targetId) => ({
    targetId,
    present: present.get(targetId) ?? 0,
    divergent: divergent.get(targetId) ?? 0,
  }));
}

/** Newest modification across every copy, or 0 when the resource has none. */
function newestModifiedAtMs(resource: LibraryResource): number {
  return resource.instances.reduce(
    (newest, instance) => Math.max(newest, instance.modifiedAtMs),
    0
  );
}

export function validInstances(resource: LibraryResource): ValidLibraryInstance[] {
  return resource.instances.filter((instance): instance is ValidLibraryInstance => instance.valid);
}

/**
 * Location ids a propagation preview is allowed to name.
 *
 * The API refuses any destination the scanner skips, so the wizard must not ask
 * about a disabled location even when that directory exists on disk. Path-null
 * locations resolve to nowhere on this platform, so there is no directory to
 * write into — the preview would only report them back as `unsupported-location`.
 */
export function propagationCandidateLocationIds(
  locations: readonly LibraryLocationStatus[],
  kind: ResourceKind,
  enabledLocationIds: ReadonlySet<LibraryLocationId>
): LibraryLocationId[] {
  return locations
    .filter(
      (location) =>
        location.kind === kind && location.path !== null && enabledLocationIds.has(location.id)
    )
    .map((location) => location.id);
}

export type LibraryShowFilter = 'all' | 'divergent' | 'single-location' | 'shadowed';
export type LibrarySort = 'name' | 'divergence' | 'coverage' | 'modified';

export interface LibraryFilters {
  readonly search: string;
  readonly targetId: LibraryTargetId | 'any';
  readonly locationId: LibraryLocationId | 'any';
  readonly show: LibraryShowFilter;
  readonly sort: LibrarySort;
  readonly groupByLocation: boolean;
}

export const DEFAULT_LIBRARY_FILTERS: LibraryFilters = {
  search: '',
  targetId: 'any',
  locationId: 'any',
  show: 'all',
  sort: 'name',
  groupByLocation: false,
};

export function hasActiveFilters(filters: LibraryFilters): boolean {
  return (
    filters.search.trim().length > 0 ||
    filters.targetId !== 'any' ||
    filters.locationId !== 'any' ||
    filters.show !== 'all'
  );
}

function matchesShowFilter(resource: LibraryResource, show: LibraryShowFilter): boolean {
  switch (show) {
    case 'divergent':
      return resource.divergence === 'divergent';
    case 'single-location':
      return resource.instances.length === 1;
    case 'shadowed':
      return resource.coverage.some((coverage) => coverage.state === 'shadowed');
    default:
      return true;
  }
}

export function filterResources(
  resources: readonly LibraryResource[],
  filters: LibraryFilters
): LibraryResource[] {
  const search = filters.search.trim().toLowerCase();
  return resources.filter((resource) => {
    if (search && !resource.ref.slug.toLowerCase().includes(search)) return false;
    if (
      filters.locationId !== 'any' &&
      !resource.instances.some((instance) => instance.locationId === filters.locationId)
    ) {
      return false;
    }
    if (filters.targetId !== 'any') {
      const coverage = resource.coverage.find(
        (candidate) => candidate.targetId === filters.targetId
      );
      if (!coverage || coverage.state === 'absent') return false;
    }
    return matchesShowFilter(resource, filters.show);
  });
}

/** Divergent first, then shadowed, then everything settled — worst news at the top. */
const DIVERGENCE_RANK: Readonly<Record<LibraryResource['divergence'], number>> = {
  divergent: 0,
  uniform: 1,
  single: 2,
  'not-comparable': 3,
};

export function sortResources(
  resources: readonly LibraryResource[],
  sort: LibrarySort
): LibraryResource[] {
  const byName = (left: LibraryResource, right: LibraryResource) =>
    left.ref.slug.localeCompare(right.ref.slug);

  return [...resources].sort((left, right) => {
    switch (sort) {
      case 'divergence':
        return (
          DIVERGENCE_RANK[left.divergence] - DIVERGENCE_RANK[right.divergence] ||
          byName(left, right)
        );
      case 'coverage':
        return presentTargetCount(left) - presentTargetCount(right) || byName(left, right);
      case 'modified':
        return newestModifiedAtMs(right) - newestModifiedAtMs(left) || byName(left, right);
      default:
        return byName(left, right);
    }
  });
}

export interface LocationGroup {
  /** Null is the catch-all bucket for resources with no readable location. */
  readonly locationId: LibraryLocationId | null;
  readonly resources: readonly LibraryResource[];
}

/**
 * Buckets rows by the location holding their first copy. A resource in several
 * locations appears once, under the first — the matrix answers "where does this
 * live", and repeating a row per location would double-count it.
 */
export function groupResourcesByLocation(resources: readonly LibraryResource[]): LocationGroup[] {
  const groups = new Map<LibraryLocationId | null, LibraryResource[]>();
  for (const resource of resources) {
    const locationId = resource.instances[0]?.locationId ?? null;
    const bucket = groups.get(locationId);
    if (bucket) bucket.push(resource);
    else groups.set(locationId, [resource]);
  }
  return [...groups].map(([locationId, grouped]) => ({ locationId, resources: grouped }));
}

const RELATIVE_UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];

/**
 * "2 days ago" in the active locale. `Intl` rather than a date library because
 * the whole need is one relative phrase, and the platform already localizes it.
 */
export function formatRelativeTime(
  timestampMs: number,
  locale: string,
  nowMs = Date.now()
): string {
  const elapsed = timestampMs - nowMs;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, span] of RELATIVE_UNITS) {
    if (Math.abs(elapsed) >= span) return formatter.format(Math.round(elapsed / span), unit);
  }
  return formatter.format(Math.round(elapsed / 1000), 'second');
}

/** Human-readable byte count for content group sizes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}
