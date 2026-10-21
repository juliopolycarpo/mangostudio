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
 */

import type { LibraryCoverage, LibraryLocationId } from '@mangostudio/shared/library';
import { Fragment } from 'react';
import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/hooks/use-i18n';
import { CoverageGlyph } from './CoverageCell';

interface CoverageListProps {
  readonly coverage: readonly LibraryCoverage[];
  readonly locationLabel: (locationId: LibraryLocationId) => string;
}

export function CoverageList({ coverage, locationLabel }: CoverageListProps) {
  const { t } = useI18n();
  const l = t.library;

  return (
    <ul className="space-y-2">
      {coverage.map((entry) => (
        <li
          key={entry.targetId}
          className="grid grid-cols-[7rem_1fr] items-baseline gap-x-3 gap-y-0.5 text-sm sm:grid-cols-[7rem_7rem_1fr]"
          data-testid="coverage-row"
          data-target-id={entry.targetId}
          data-state={entry.state}
        >
          <span className="font-medium text-fg">{l.targets[entry.targetId]}</span>
          <span className="inline-flex items-baseline gap-1.5 text-fg-muted">
            <CoverageGlyph state={entry.state} />
            {l.coverage[entry.state]}
          </span>
          {/*
            A location is only reported as a shadow here — the matrix keeps
            that as an implementation detail until someone asks, and this is
            where they asked.
          */}
          {(entry.effectiveLocationId || entry.shadowedLocationIds.length > 0) && (
            <div className="col-span-2 min-w-0 space-y-1.5 text-fg-muted text-xs sm:col-span-1">
              {entry.effectiveLocationId && (
                <div>
                  <p>{l.detail.via}</p>
                  <PathLine path={locationLabel(entry.effectiveLocationId)} />
                </div>
              )}
              {entry.shadowedLocationIds.length > 0 && (
                <div>
                  <p className="flex flex-wrap items-center gap-x-1.5">
                    {l.detail.alsoIn}
                    <Badge>{l.detail.identical}</Badge>
                  </p>
                  {entry.shadowedLocationIds.map((locationId) => (
                    <PathLine key={locationId} path={locationLabel(locationId)} />
                  ))}
                </div>
              )}
            </div>
          )}
        </li>
      ))}
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
    <code className="block font-mono text-fg [overflow-wrap:anywhere]">
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
