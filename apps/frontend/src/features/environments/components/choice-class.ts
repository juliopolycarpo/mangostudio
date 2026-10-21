import { cn } from '@/lib/utils';

/**
 * A pick-one tile: a bordered, clickable row where the chosen option takes the
 * neutral selected fill. The accent is left to the check mark and the focus
 * outline, so a stack of these does not read as a stack of primary buttons.
 * Radius is `sm` because the tile is something you click.
 *
 * Every tile, chosen or not, wears the control line (`stroke-strong`, 3:1): a
 * tile is a control, and the decorative hairline is below the contrast a
 * control's edge has to clear. The chosen one is told apart by its fill, its
 * weight and the check beside it, not by the line alone.
 */
export function choiceClass(active: boolean): string {
  return cn(
    'min-h-8 rounded-sm border px-3 py-1.5 text-left text-sm transition-colors',
    'border-stroke-strong',
    active
      ? 'bg-fill-selected font-medium text-fg'
      : 'text-fg-muted hover:bg-fill-hover hover:text-fg'
  );
}
