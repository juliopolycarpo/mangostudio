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
 *
 * Where the agents do not fit, the table scrolls sideways under the checkbox and
 * the resource name, which stay put: the comparison is across a row, and a row
 * whose name has scrolled away answers nothing. The column that is cut off at
 * the edge, and the scrollbar, are what say there is more.
 */

import type {
  LibraryLocationStatus,
  LibraryResource,
  LibraryTargetDescriptor,
} from '@mangostudio/shared/library';
import { Link } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef } from 'react';
import { Checkbox } from '@/components/ui/Checkbox';
import { ToolAvatar } from '@/components/ui/ToolAvatar';
import { useToolIdentities } from '@/features/environments/identity/use-tool-identities';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { cn } from '@/lib/utils';
import { type CoverageCellState, coverageCells, type LocationGroup } from '../format';
import { libraryEnvironmentSearch } from '../queries';
import { CoverageCell, CoverageGlyph } from './CoverageCell';

const ROW_HEIGHT_PX = 40;

/**
 * The two leading columns, pinned to the left edge of the scroll container.
 * `left-9` is the checkbox column's width (`w-9`). The divider after the resource
 * is a pseudo-element, not a border: in a collapsed-border table a cell's border
 * belongs to the grid and scrolls away instead of staying with the cell.
 */
const PINNED_CHECKBOX = 'sticky left-0 bg-surface';
const PINNED_RESOURCE =
  'sticky left-9 bg-surface before:absolute before:inset-y-0 before:right-0 before:w-px before:bg-stroke';

/**
 * A pinned cell is opaque, because the agent cells slide under it, and an opaque
 * cell hides the row's own hover and selection wash. This draws the wash again
 * on a pseudo-element behind the cell's content (`group` is on the row; the
 * selected row adds `after:bg-fill-selected` itself).
 */
const PINNED_ROW_WASH =
  'after:pointer-events-none after:absolute after:inset-0 after:-z-10 group-hover:after:bg-fill-hover';

/**
 * The selection checkbox (`w-9`) and the resource column at `sm` and up
 * (`w-48`), in rem. Below `sm` the resource column is `w-40`, narrower than
 * this counts, so the agent columns only get more than their minimum there.
 */
const LEADING_COLUMNS_REM = 14.25;
/** Room for the widest header — the avatar and "Claude Code" — plus the cell padding, in rem. */
const AGENT_COLUMN_MIN_REM = 7;
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
  readonly environmentId: string;
}

export function CoverageMatrix({
  groups,
  targets,
  locations,
  selected,
  onToggleSelected,
  onToggleAll,
  environmentId,
}: CoverageMatrixProps) {
  const { t } = useI18n();
  const l = t.library;
  // A column is an agent, and it is named here exactly as its environments card
  // names it — the matrix is the same tools seen from a different angle.
  const { resolve } = useToolIdentities();
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
      className="app-scrollbar max-h-[60vh] overflow-auto rounded-md border border-stroke bg-surface"
      data-testid="coverage-matrix"
    >
      {/*
        Fixed layout: every agent column is the same width on every tab, so the
        same header sits in the same place and a glyph in a column stays in it.
        Auto layout sized each column to its widest cell, and the grid moved
        whenever a state word did. The agent columns carry no width of their own,
        which splits whatever the two leading columns leave for any number of
        targets; below the minimum the container scrolls sideways instead.
      */}
      <table
        className="w-full table-fixed border-collapse text-sm"
        style={{ minWidth: `${LEADING_COLUMNS_REM + targets.length * AGENT_COLUMN_MIN_REM}rem` }}
      >
        <colgroup>
          <col className="w-9" />
          {/* Narrower on a phone, where the pinned half of the table is most of the
              screen and the agent column beside it has to be visibly cut off — but
              wide enough that a typical slug stays on one line, since a name broken
              at its own hyphen reads as two words. */}
          <col className="w-40 sm:w-48" />
          {targets.map((target) => (
            <col key={target.id} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-stroke border-b">
            <th scope="col" className={cn('w-9 px-2 py-2', PINNED_CHECKBOX)}>
              <Checkbox
                checked={allSelected}
                onChange={onToggleAll}
                aria-label={l.matrix.selectAll}
                className="align-middle"
              />
            </th>
            <th
              scope="col"
              className={cn(
                'px-2 py-2 text-left font-medium text-fg-muted text-xs',
                PINNED_RESOURCE
              )}
            >
              {l.matrix.resourceColumn}
            </th>
            {targets.map((target) => {
              const identity = resolve('agent', target.id, l.targets[target.id]);
              return (
                <th
                  key={target.id}
                  scope="col"
                  data-target-id={target.id}
                  className="px-2 py-2 text-left font-medium text-fg-muted text-xs"
                >
                  <span className="flex items-center gap-1.5">
                    <ToolAvatar
                      subjectKey={identity.subjectKey}
                      monogram={identity.monogram}
                      name={identity.name}
                      image={identity.image}
                      size="xs"
                    />
                    <span className="truncate">{identity.name}</span>
                  </span>
                </th>
              );
            })}
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
                <tr key={row.key} className="bg-surface">
                  <td colSpan={targets.length + 2} className="micro-label px-3 py-1.5">
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
                environmentId={environmentId}
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
  environmentId,
}: {
  readonly resource: LibraryResource;
  readonly locations: readonly LibraryLocationStatus[];
  readonly selected: boolean;
  readonly onToggleSelected: (resourceKey: string) => void;
  readonly environmentId: string;
}) {
  const { t } = useI18n();
  const l = t.library;
  const cells = coverageCells(resource);

  return (
    <tr
      className={cn(
        'group border-stroke border-b last:border-b-0 hover:bg-fill-hover',
        selected && 'bg-fill-selected'
      )}
      data-testid="matrix-row"
      data-resource-key={resource.key}
      data-divergence={resource.divergence}
      style={{ height: ROW_HEIGHT_PX }}
    >
      <td
        className={cn(
          'px-2 py-1.5',
          PINNED_CHECKBOX,
          PINNED_ROW_WASH,
          selected && 'after:bg-fill-selected'
        )}
      >
        <Checkbox
          checked={selected}
          onChange={() => onToggleSelected(resource.key)}
          aria-label={formatMessage(l.matrix.selectRow, { resource: resource.ref.slug })}
          className="align-middle"
        />
      </td>
      <td
        className={cn(
          'min-w-0 px-2 py-1.5',
          PINNED_RESOURCE,
          PINNED_ROW_WASH,
          selected && 'after:bg-fill-selected'
        )}
      >
        <Link
          to="/environments/library/$resourceKey"
          params={{ resourceKey: resource.key }}
          search={libraryEnvironmentSearch(environmentId)}
          aria-label={formatMessage(l.matrix.openDetail, { resource: resource.ref.slug })}
          // A slug is an identifier: it never breaks at its own hyphen. One too
          // long for the column ends in an ellipsis, with the whole name in the
          // tooltip and the accessible name.
          title={resource.ref.slug}
          // A flex row, not a block: on a coarse pointer the link takes the 44px
          // touch floor, and a block keeps its text on the top line of that box
          // while the checkbox and the cells beside it centre in the row.
          className="flex min-w-0 items-center font-medium text-fg hover:underline"
        >
          <span className="min-w-0 truncate">{resource.ref.slug}</span>
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
  'incomparable',
  'only-here',
];

/**
 * The glyph key, spelled out. A symbol nobody can decode is decoration.
 *
 * Only where it is needed: from `xl` up the cells print the state's word beside
 * the glyph, so a key above the table would say again what every row says, and
 * it pushed the first row down by a band. Below `xl` the cells are glyphs alone
 * and this is the way to read them. The words are the short ones the cells use;
 * the full sentence for each state is its tooltip.
 */
export function MatrixLegend() {
  const { t } = useI18n();
  const l = t.library;

  return (
    <dl
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-fg-muted text-xs xl:hidden"
      aria-label={l.matrix.legend}
    >
      {LEGEND_ORDER.map((state) => (
        <div key={state} className="flex items-center gap-1.5" title={l.cellHint[state]}>
          <dt aria-hidden="true" className="flex">
            <CoverageGlyph state={state} />
          </dt>
          <dd>{l.cellStateShort[state]}</dd>
        </div>
      ))}
    </dl>
  );
}
