import { cn } from '@/lib/utils';

/**
 * A pick-one tile: a bordered, clickable row where the chosen option takes the
 * neutral selected fill and the stronger line. The accent is left to the check
 * mark and the focus outline, so a stack of these does not read as a stack of
 * primary buttons. Radius is `sm` because the tile is something you click.
 */
export function choiceClass(active: boolean): string {
  return cn(
    'min-h-8 rounded-sm border px-3 py-1.5 text-left text-sm transition-colors',
    active
      ? 'border-stroke-strong bg-fill-selected font-medium text-fg'
      : 'border-stroke text-fg-muted hover:bg-fill-hover hover:text-fg'
  );
}
