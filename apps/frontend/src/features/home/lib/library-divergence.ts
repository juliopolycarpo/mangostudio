/**
 * What the hub's library card says, derived from the same coverage resolver the
 * library matrix uses.
 *
 * Divergence leads and a coverage gap does not, because they are not the same
 * news. Two harnesses reading different bytes of one resource is a
 * contradiction somebody has to resolve; a skill Cursor simply does not have is
 * very often exactly what its author wanted — `features/library/format.ts` says
 * so in as many words, and a hub that headlines "missing in Cursor" spends the
 * user's attention pushing them to propagate things they scoped deliberately.
 *
 * So: the headline is a divergence, the gap is a footnote, and the footnote's
 * way out is the library rather than a one-click write.
 *
 * Nothing here reads the resource's kind as anything but a label, which is why
 * the same summary serves the chat hub's skills-only scan and the dashboard's
 * scan across every kind — only the query that feeds it names a kind.
 */

import type { LibraryResource, LibraryTargetId, ResourceKind } from '@mangostudio/shared/library';
import { coverageCells, presentTargetCount } from '@/features/library/format';

export interface LibraryDivergenceSummary {
  /** The one divergence the card names. Null when nothing disagrees. */
  readonly headline: DivergentResource | null;
  /** Divergent resources in total, so the card can say "and 2 more". */
  readonly divergentCount: number;
  /** Resources exactly one harness reads. Reported, never framed as a problem. */
  readonly singleTargetCount: number;
}

export interface DivergentResource {
  readonly key: string;
  readonly slug: string;
  /**
   * What kind of resource this is. Two kinds may use the same slug, so a card
   * that scanned more than one has to say which one it is naming.
   */
  readonly kind: ResourceKind;
  /** Harnesses reading a version the others do not agree on. Never empty. */
  readonly outliers: readonly LibraryTargetId[];
  /** Harnesses reading the version the outliers disagree with. May be empty. */
  readonly agreeing: readonly LibraryTargetId[];
}

/**
 * Sorted so the card is stable across refetches: the scan's own order is a
 * directory walk, and a card whose headline changes on every poll is unusable.
 *
 * Kind breaks a slug tie for the same reason — an all-kinds scan can hold two
 * resources named `deploy`, and a comparison that called them equal would let
 * the sort leave them in whichever order the walk produced.
 */
function byKindAndSlug(left: LibraryResource, right: LibraryResource): number {
  return left.ref.slug.localeCompare(right.ref.slug) || left.ref.kind.localeCompare(right.ref.kind);
}

function describeDivergentResource(resource: LibraryResource): DivergentResource | null {
  const outliers: LibraryTargetId[] = [];
  const agreeing: LibraryTargetId[] = [];
  for (const cell of coverageCells(resource)) {
    if (cell.state === 'divergent') outliers.push(cell.targetId);
    else if (cell.state !== 'absent') agreeing.push(cell.targetId);
  }
  // `divergence: 'divergent'` is the resource-level verdict and the cells are
  // the per-target reading of it. They agree in every case the resolver can
  // produce, but a resource whose cells all came back settled has nothing to
  // name, and naming nothing is worse than staying quiet.
  if (outliers.length === 0) return null;
  return {
    key: resource.key,
    slug: resource.ref.slug,
    kind: resource.ref.kind,
    outliers,
    agreeing,
  };
}

/**
 * // Usage: summarizeLibraryDivergence(scan.resources)
 */
export function summarizeLibraryDivergence(
  resources: readonly LibraryResource[]
): LibraryDivergenceSummary {
  const divergent = resources
    .filter((resource) => resource.divergence === 'divergent')
    .sort(byKindAndSlug);
  const described = divergent
    .map(describeDivergentResource)
    .filter((resource): resource is DivergentResource => resource !== null);

  return {
    headline: described[0] ?? null,
    divergentCount: described.length,
    singleTargetCount: resources.filter((resource) => presentTargetCount(resource) === 1).length,
  };
}
