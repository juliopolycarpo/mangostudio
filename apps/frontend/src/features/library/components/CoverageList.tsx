/**
 * What each agent reads of one resource: the detail page's answer to "who sees
 * this?", row by row.
 *
 * The same states as the matrix, drawn the same way — a toned glyph with the
 * state's word beside it — so Shadowed and Absent are as distinct here as they
 * are there. The rows are three aligned columns from `sm` (agent, state, where
 * it is read from); below that the where drops to its own line under the first
 * two, so a long path wraps across the full width instead of beside the state.
 *
 * A path is technical content, so it is set in mono as it is in the content
 * cards above, each on a line of its own; the words that introduce it are the
 * same 12px muted size, so nothing in the cell is larger than the path.
 *
 * Each shadowed location carries its own badge saying whether its copy matches
 * the one the agent reads, worked out from the hashes rather than assumed: the
 * Content section above lists the same hashes, and the two must agree.
 */

import type { LibraryLocationId, LibraryResource } from '@mangostudio/shared/library';
import { Fragment } from 'react';
import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/hooks/use-i18n';
import { coverageCell, type ShadowedCopyComparison, shadowedCopyComparison } from '../format';
import { CoverageGlyph } from './CoverageCell';

interface CoverageListProps {
  readonly resource: LibraryResource;
  readonly locationLabel: (locationId: LibraryLocationId) => string;
}

/** A copy that differs is the one worth a second look; the rest are plain facts. */
const COMPARISON_VARIANTS = {
  identical: 'neutral',
  differs: 'warning',
  unknown: 'neutral',
} as const satisfies Record<ShadowedCopyComparison, 'neutral' | 'warning'>;

export function CoverageList({ resource, locationLabel }: CoverageListProps) {
  const { t } = useI18n();
  const l = t.library;

  return (
    <ul className="space-y-2">
      {resource.coverage.map((entry) => {
        // The matrix's reading of the same facts, so the detail page can never
        // call a copy present where the matrix row it came from says it differs.
        const cell = coverageCell(resource, entry);
        return (
          <li
            key={cell.targetId}
            className="grid grid-cols-[7rem_1fr] items-baseline gap-x-3 gap-y-0.5 text-sm sm:grid-cols-[7rem_9rem_1fr]"
            data-testid="coverage-row"
            data-target-id={cell.targetId}
            data-state={cell.state}
          >
            <span className="font-medium text-fg">{l.targets[cell.targetId]}</span>
            <span className="inline-flex items-baseline gap-1.5 text-fg-muted">
              <CoverageGlyph state={cell.state} />
              {l.cellStateShort[cell.state]}
            </span>
            {/*
              A location is only reported as a shadow here — the matrix keeps
              that as an implementation detail until someone asks, and this is
              where they asked.
            */}
            {(cell.effectiveLocationId || cell.shadowedLocationIds.length > 0) && (
              <div className="col-span-2 min-w-0 space-y-1.5 text-fg-muted text-xs sm:col-span-1">
                {cell.effectiveLocationId && (
                  <div>
                    <p>{l.detail.via}</p>
                    <PathLine path={locationLabel(cell.effectiveLocationId)} />
                  </div>
                )}
                {cell.shadowedLocationIds.length > 0 && (
                  <div>
                    <p>{l.detail.alsoIn}</p>
                    {cell.shadowedLocationIds.map((locationId) => {
                      const comparison = shadowedCopyComparison(resource, cell, locationId);
                      return (
                        <div
                          key={locationId}
                          className="flex items-baseline gap-1.5"
                          data-testid="coverage-shadow"
                          data-comparison={comparison}
                        >
                          <PathLine path={locationLabel(locationId)} />
                          <Badge variant={COMPARISON_VARIANTS[comparison]}>
                            {l.detail.shadowCopy[comparison]}
                          </Badge>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One path on its own line, in mono. It may break after any `/` before it breaks
 * inside a name, so `.claude/skills` is never cut as `.claude/skill` + `s`.
 */
function PathLine({ path }: { readonly path: string }) {
  let offset = 0;
  return (
    <code className="block min-w-0 font-mono text-fg [overflow-wrap:anywhere]">
      {path.split(/(?<=\/)/).map((segment) => {
        const key = offset;
        offset += segment.length;
        return (
          <Fragment key={key}>
            {segment}
            <wbr />
          </Fragment>
        );
      })}
    </code>
  );
}
