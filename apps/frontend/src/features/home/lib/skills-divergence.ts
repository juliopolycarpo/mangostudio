/**
 * What the hub's skills card says, derived from the same coverage resolver the
 * library matrix uses.
 *
 * Divergence leads and a coverage gap does not, because they are not the same
 * news. Two harnesses reading different bytes of one skill is a contradiction
 * somebody has to resolve; a skill Cursor simply does not have is very often
 * exactly what its author wanted — `features/library/format.ts` says so in as
 * many words, and a hub that headlines "missing in Cursor" spends the user's
 * attention pushing them to propagate things they scoped deliberately.
 *
 * So: the headline is a divergence, the gap is a footnote, and the footnote's
 * way out is the library rather than a one-click write.
 */

import type { LibraryResource, LibraryTargetId } from '@mangostudio/shared/library';
import { coverageCells, presentTargetCount } from '@/features/library/format';

export interface SkillsDivergenceSummary {
  /** The one divergence the card names. Null when nothing disagrees. */
  readonly headline: DivergentSkill | null;
  /** Divergent skills in total, so the card can say "and 2 more". */
  readonly divergentCount: number;
  /** Skills exactly one harness reads. Reported, never framed as a problem. */
  readonly singleTargetCount: number;
}

export interface DivergentSkill {
  readonly key: string;
  readonly slug: string;
  /** Harnesses reading a version the others do not agree on. Never empty. */
  readonly outliers: readonly LibraryTargetId[];
  /** Harnesses reading the version the outliers disagree with. May be empty. */
  readonly agreeing: readonly LibraryTargetId[];
}

/**
 * Sorted so the card is stable across refetches: the scan's own order is a
 * directory walk, and a card whose headline changes on every poll is unusable.
 */
function bySlug(left: LibraryResource, right: LibraryResource): number {
  return left.ref.slug.localeCompare(right.ref.slug);
}

function describeDivergentSkill(resource: LibraryResource): DivergentSkill | null {
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
  return { key: resource.key, slug: resource.ref.slug, outliers, agreeing };
}

/**
 * // Usage: summarizeSkillsDivergence(scan.resources)
 */
export function summarizeSkillsDivergence(
  resources: readonly LibraryResource[]
): SkillsDivergenceSummary {
  const divergent = resources
    .filter((resource) => resource.divergence === 'divergent')
    .sort(bySlug);
  const described = divergent
    .map(describeDivergentSkill)
    .filter((skill): skill is DivergentSkill => skill !== null);

  return {
    headline: described[0] ?? null,
    divergentCount: described.length,
    singleTargetCount: resources.filter((resource) => presentTargetCount(resource) === 1).length,
  };
}
