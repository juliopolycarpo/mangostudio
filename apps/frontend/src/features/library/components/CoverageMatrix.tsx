/**
 * The coverage matrix: rows are resources, columns are targets.
 *
 * A column is a *target*, not a location. Codex reading two directories is an
 * implementation detail until the user asks for it, and the detail view is
 * where that question gets answered.
 *
 * Rows are virtualized from the start. Forty resources across four targets is
 * comfortable; three hundred is not, and retrofitting virtualization onto a
 * table people already rely on is worse than paying for it now.
 */

import type {
  LibraryLocationStatus,
  LibraryResource,
  LibraryTargetDescriptor,
} from '@mangostudio/shared/library';
import { Link } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { CELL_GLYPHS, type CoverageCellState, coverageCells, type LocationGroup } from '../format';
import { CoverageCell } from './CoverageCell';

const ROW_HEIGHT_PX = 40;
const OVERSCAN_ROWS = 8;

/**
 * Assumed viewport height until the scroll container is measured. Without it
 * the first paint computes a zero-height window and renders no rows at all,
 * which reads as an empty library for a frame.
 */
const INITIAL_VIEWPORT_PX = 600;

type MatrixRow =
  | { readonly kind: 'group'; readonly key: string; readonly label: string }
  | { readonly kind: 'resource'; readonly key: string; readonly resource: LibraryResource };

interface CoverageMatrixProps {
  readonly groups: readonly LocationGroup[];
  readonly targets: readonly LibraryTargetDescriptor[];
  readonly locations: readonly LibraryLocationStatus[];
  readonly selected: ReadonlySet<string>;
  readonly onToggleSelected: (resourceKey: string) => void;
  readonly onToggleAll: () => void;
}

export function CoverageMatrix({
  groups,
  targets,
  locations,
  selected,
  onToggleSelected,
  onToggleAll,
}: CoverageMatrixProps) {
  const { t } = useI18n();
  const l = t.library;
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo<MatrixRow[]>(
    () =>
      groups.flatMap((group) => {
        const resourceRows = group.resources.map<MatrixRow>((resource) => ({
          kind: 'resource',
          key: resource.key,
          resource,
        }));
        if (group.locationId === null && groups.length === 1) return resourceRows;
        const path = locations.find((candidate) => candidate.id === group.locationId)?.path;
        return [
          {
            kind: 'group' as const,
            key: `group:${group.locationId ?? 'other'}`,
            label:
              group.locationId === null
                ? l.matrix.locationGroupOther
                : formatMessage(l.matrix.locationGroup, {
                    location: path ?? group.locationId,
                  }),
          },
          ...resourceRows,
        ];
      }),
    [groups, locations, l.matrix.locationGroup, l.matrix.locationGroupOther]
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: OVERSCAN_ROWS,
    initialRect: { width: 0, height: INITIAL_VIEWPORT_PX },
  });

  const virtualRows = virtualizer.getVirtualItems();
  const paddingTop = virtualRows[0]?.start ?? 0;
  const paddingBottom = virtualizer.getTotalSize() - (virtualRows.at(-1)?.end ?? 0);

  const selectableKeys = rows.flatMap((row) => (row.kind === 'resource' ? [row.key] : []));
  const allSelected = selectableKeys.length > 0 && selectableKeys.every((key) => selected.has(key));

  return (
    <div
      ref={scrollRef}
      className="app-scrollbar max-h-[60vh] overflow-auto rounded-2xl border border-outline-variant/15 bg-surface-container-high"
      data-testid="coverage-matrix"
    >
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-surface-container-high">
          <tr className="border-outline-variant/15 border-b">
            <th scope="col" className="w-9 px-2 py-2">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={onToggleAll}
                aria-label={l.matrix.selectAll}
                className="size-3.5 accent-primary"
              />
            </th>
            <th
              scope="col"
              className="px-2 py-2 text-left font-label font-semibold text-[11px] text-on-surface-variant/70 uppercase tracking-wider"
            >
              {l.matrix.resourceColumn}
            </th>
            {targets.map((target) => (
              <th
                key={target.id}
                scope="col"
                className="px-2 py-2 text-center font-label font-semibold text-[11px] text-on-surface-variant/70 uppercase tracking-wider"
              >
                {l.targets[target.id]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {paddingTop > 0 && (
            <tr>
              <td aria-hidden="true" colSpan={targets.length + 2} style={{ height: paddingTop }} />
            </tr>
          )}
          {virtualRows.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (row.kind === 'group') {
              return (
                <tr key={row.key} className="bg-surface-container">
                  <td
                    colSpan={targets.length + 2}
                    className="px-3 py-1.5 font-label font-semibold text-[10px] text-on-surface-variant/70 uppercase tracking-widest"
                  >
                    {row.label}
                  </td>
                </tr>
              );
            }
            return (
              <ResourceRow
                key={row.key}
                resource={row.resource}
                locations={locations}
                selected={selected.has(row.key)}
                onToggleSelected={onToggleSelected}
              />
            );
          })}
          {paddingBottom > 0 && (
            <tr>
              <td
                aria-hidden="true"
                colSpan={targets.length + 2}
                style={{ height: paddingBottom }}
              />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ResourceRow({
  resource,
  locations,
  selected,
  onToggleSelected,
}: {
  readonly resource: LibraryResource;
  readonly locations: readonly LibraryLocationStatus[];
  readonly selected: boolean;
  readonly onToggleSelected: (resourceKey: string) => void;
}) {
  const { t } = useI18n();
  const l = t.library;
  const cells = coverageCells(resource);

  return (
    <tr
      className="border-outline-variant/10 border-b last:border-b-0 hover:bg-surface-container-highest/50"
      data-testid="matrix-row"
      data-resource-key={resource.key}
      data-divergence={resource.divergence}
      style={{ height: ROW_HEIGHT_PX }}
    >
      <td className="px-2 py-1.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelected(resource.key)}
          aria-label={formatMessage(l.matrix.selectRow, { resource: resource.ref.slug })}
          className="size-3.5 accent-primary"
        />
      </td>
      <td className="min-w-0 px-2 py-1.5">
        <Link
          to="/library/$resourceKey"
          params={{ resourceKey: resource.key }}
          aria-label={formatMessage(l.matrix.openDetail, { resource: resource.ref.slug })}
          className="block truncate font-medium text-on-surface hover:text-primary"
        >
          {resource.ref.slug}
        </Link>
      </td>
      {cells.map((cell) => (
        <CoverageCell
          key={cell.targetId}
          cell={cell}
          resourceSlug={resource.ref.slug}
          locations={locations}
        />
      ))}
    </tr>
  );
}

const LEGEND_ORDER: readonly CoverageCellState[] = [
  'present',
  'absent',
  'shadowed',
  'divergent',
  'only-here',
];

/** The glyph key, spelled out. A symbol nobody can decode is decoration. */
export function MatrixLegend() {
  const { t } = useI18n();
  const l = t.library;

  return (
    <dl
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-on-surface-variant/70"
      aria-label={l.matrix.legend}
    >
      {LEGEND_ORDER.map((state) => (
        <div key={state} className="flex items-center gap-1.5">
          <dt aria-hidden="true">{CELL_GLYPHS[state]}</dt>
          <dd>{l.cellState[state]}</dd>
        </div>
      ))}
    </dl>
  );
}
