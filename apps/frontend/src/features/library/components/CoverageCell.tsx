/**
 * One cell of the coverage matrix.
 *
 * Never colour or glyph alone: every cell carries an `aria-label` naming the
 * resource, the target, and the state in words, and the text label appears
 * alongside the glyph once there is room for it, as a short word — the full
 * sentence is the tooltip and the accessible name. The glyph takes the state's
 * colour; the word stays in `fg-muted`. A user who cannot tell the stacked
 * layers from the warning triangle — or cannot see either — still gets the
 * whole answer.
 */

import type { LibraryLocationStatus } from '@mangostudio/shared/library';
import {
  Check,
  CircleHelp,
  Layers,
  type LucideIcon,
  Minus,
  Star,
  TriangleAlert,
} from 'lucide-react';

import { useI18n } from '@/hooks/use-i18n';
import { formatMessage, formatRelativeTime } from '@/lib/i18n-format';
import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

import { type CoverageCell as Cell, hashPrefix } from '../format';

/**
 * The icon carrying each state. Never the only signal — every cell is also
 * labelled. Lucide rather than Unicode symbols: each character had its own
 * advance width and weight (a hairline ✓ beside a filled ⚠), so the words
 * printed after them started at different x positions down a column.
 */
const STATE_ICONS: Readonly<Record<Cell['state'], LucideIcon>> = {
  present: Check,
  absent: Minus,
  shadowed: Layers,
  divergent: TriangleAlert,
  'only-here': Star,
  incomparable: CircleHelp,
};

/**
 * The glyph's colour per state. Attention (copies that differ, or cannot be
 * compared) is `warning`: the library is working, and the user may want to
 * reconcile. Nothing here is an error, so nothing is `danger`.
 */
const STATE_TONES: Readonly<Record<Cell['state'], string>> = {
  present: 'text-success',
  absent: 'text-fg-subtle',
  shadowed: 'text-info',
  divergent: 'text-warning',
  'only-here': 'text-info',
  incomparable: 'text-warning',
};

/**
 * The one drawing of a coverage state: its icon, in the state's colour.
 *
 * The matrix cells, the legend that explains them and the detail page's
 * per-agent rows all use it, so a state looks the same wherever it is met. It is
 * decoration (`aria-hidden`): the caller prints the state's word beside it.
 *
 * A fixed 14px box, so every state takes the same width and the words beside
 * them line up down a column. Inside a baseline-aligned row the box centres
 * itself on the line rather than sitting on the baseline.
 */
export function CoverageGlyph({
  state,
  className,
}: {
  readonly state: Cell['state'];
  readonly className?: string;
}) {
  const Icon = STATE_ICONS[state];
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-3.5 shrink-0 items-center justify-center self-center',
        STATE_TONES[state],
        className
      )}
    >
      <Icon size={ICON_SM} />
    </span>
  );
}

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
      className="px-2 py-1.5 text-left align-middle"
      aria-label={label}
      // The tooltip carries the facts needed to act without leaving the matrix.
      title={cellTitle(cell, locations, l, locale)}
      data-testid="coverage-cell"
      data-state={cell.state}
      data-target={cell.targetId}
    >
      <span aria-hidden="true" className="flex items-center gap-1.5">
        <CoverageGlyph state={cell.state} />
        <span className="hidden min-w-0 truncate text-xs text-fg-muted xl:inline">
          {l.cellStateShort[cell.state]}
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
