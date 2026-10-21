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
 * cards above; the words around it stay in the interface font.
 */

import type { LibraryCoverage, LibraryLocationId } from '@mangostudio/shared/library';
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
            <div className="col-span-2 min-w-0 break-words text-fg-muted sm:col-span-1">
              {entry.effectiveLocationId && (
                <p>
                  <PathMessage
                    template={l.detail.via}
                    path={locationLabel(entry.effectiveLocationId)}
                  />
                </p>
              )}
              {entry.shadowedLocationIds.length > 0 && (
                <p>
                  <PathMessage
                    template={l.detail.alsoIn}
                    path={entry.shadowedLocationIds.map(locationLabel).join(', ')}
                  />
                </p>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * A message with one path in it, the path in mono.
 *
 * `formatMessage` returns a string, which cannot carry a differently-styled
 * span, so the template is cut at its one placeholder instead. The placeholder
 * is `{location}` or `{locations}` — whichever the sentence uses — and the words
 * on either side keep the language's own order.
 */
function PathMessage({ template, path }: { readonly template: string; readonly path: string }) {
  const [before = '', after = ''] = template.split(/\{locations?\}/);
  return (
    <>
      {before}
      <span className="break-all font-mono text-xs">{path}</span>
      {after}
    </>
  );
}
