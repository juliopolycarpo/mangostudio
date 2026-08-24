/**
 * One cell of the coverage matrix.
 *
 * Never colour or glyph alone: every cell carries an `aria-label` naming the
 * resource, the target, and the state in words, and the text label appears
 * alongside the glyph once there is room for it. A user who cannot tell ⧉ from
 * ⚠ — or cannot see either — still gets the whole answer.
 */

import type { LibraryLocationStatus } from '@mangostudio/shared/library';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage, formatRelativeTime } from '@/lib/i18n-format';
import { CELL_GLYPHS, type CoverageCell as Cell, hashPrefix } from '../format';

const STATE_TONES: Readonly<Record<Cell['state'], string>> = {
  present: 'text-primary',
  absent: 'text-on-surface-variant/35',
  shadowed: 'text-tertiary',
  divergent: 'text-error',
  'only-here': 'text-tertiary',
  incomparable: 'text-warning',
};

interface CoverageCellProps {
  readonly cell: Cell;
  readonly resourceSlug: string;
  readonly locations: readonly LibraryLocationStatus[];
}

export function CoverageCell({ cell, resourceSlug, locations }: CoverageCellProps) {
  const { t, locale } = useI18n();
  const l = t.library;
  const stateLabel = l.cellState[cell.state];
  const label = formatMessage(l.matrix.cellLabel, {
    resource: resourceSlug,
    target: l.targets[cell.targetId],
    state: stateLabel,
  });

  return (
    // The label lives on the cell so the accessible name is the whole sentence:
    // resource, target, and state. The glyph and the short text are decoration
    // on top of it, never the only way to read the answer.
    <td
      className="px-2 py-1.5 text-center align-middle"
      aria-label={label}
      // The tooltip carries the facts needed to act without leaving the matrix.
      title={cellTitle(cell, locations, l, locale)}
      data-testid="coverage-cell"
      data-state={cell.state}
      data-target={cell.targetId}
    >
      <span aria-hidden="true" className="inline-flex items-center justify-center gap-1.5">
        <span className={`text-sm leading-none ${STATE_TONES[cell.state]}`}>
          {CELL_GLYPHS[cell.state]}
        </span>
        <span className={`hidden text-[11px] xl:inline ${STATE_TONES[cell.state]}`}>
          {stateLabel}
        </span>
      </span>
    </td>
  );
}

function locationPath(
  locations: readonly LibraryLocationStatus[],
  locationId: string | undefined
): string | undefined {
  if (locationId === undefined) return undefined;
  const location = locations.find((candidate) => candidate.id === locationId);
  return location?.path ?? locationId;
}

/**
 * Path, content hash, and modification time — the three facts that decide
 * whether a cell needs attention, without a round trip to the detail view.
 */
function cellTitle(
  cell: Cell,
  locations: readonly LibraryLocationStatus[],
  l: ReturnType<typeof useI18n>['t']['library'],
  locale: string
): string {
  if (cell.state === 'absent') return l.tooltip.absent;

  const lines = [l.cellHint[cell.state]];
  const path = locationPath(locations, cell.effectiveLocationId);
  if (path) lines.push(`${l.tooltip.path}: ${path}`);
  if (cell.contentHash) lines.push(`${l.tooltip.hash}: ${hashPrefix(cell.contentHash)}…`);
  if (cell.modifiedAtMs !== undefined) {
    lines.push(`${l.tooltip.modified}: ${formatRelativeTime(cell.modifiedAtMs, locale)}`);
  }
  if (cell.shadowedLocationIds.length > 0) {
    const shadowed = cell.shadowedLocationIds
      .map((locationId) => locationPath(locations, locationId) ?? locationId)
      .join(', ');
    lines.push(`${l.tooltip.alsoIn}: ${shadowed}`);
  }
  return lines.join('\n');
}
