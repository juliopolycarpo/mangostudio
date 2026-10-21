import type { LucideIcon } from 'lucide-react';
import { SELECTION_BAR } from '@/components/ui/selection-bar';
import { ICON_LG, ICON_MD } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

interface NavItemProps {
  icon: LucideIcon;
  label: string;
  active: boolean;
  /**
   * A count of things needing attention behind this entry. Rendered only when
   * positive, and only on the desktop rail: the mobile tile is an icon under a
   * word with no room left over, and a badge squeezed in there stops being
   * legible without becoming any less alarming.
   */
  badgeLabel?: string;
  /** `horizontal` is the desktop rail row; `vertical` the mobile shortcut tile. */
  orientation?: 'horizontal' | 'vertical';
  onClick: () => void;
}

/** One sidebar navigation entry, shared by the desktop rail and the mobile grid. */
export function NavItem({
  icon: Icon,
  label,
  active,
  badgeLabel,
  orientation = 'horizontal',
  onClick,
}: NavItemProps) {
  const horizontal = orientation === 'horizontal';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative w-full rounded-sm transition-colors',
        horizontal
          ? 'flex h-8 items-center gap-2 px-2 text-left text-sm'
          : 'flex flex-col items-center justify-center gap-1 p-2 text-xs',
        // The current page is a neutral fill plus a 3px accent bar on the leading
        // edge — the NavigationView's own signal. The bar is what carries the
        // colour; the fill alone would not survive a grayscale screen.
        active
          ? cn('bg-fill-selected font-medium text-fg', horizontal && SELECTION_BAR)
          : 'text-fg-muted hover:bg-fill-hover hover:text-fg'
      )}
    >
      <Icon size={horizontal ? ICON_MD : ICON_LG} className="shrink-0" />
      {/* `max-w-full`: in the tile's column the label is as wide as its text
          however narrow the cell is, so "Environments" ran past its neighbours
          instead of ending in an ellipsis. */}
      <span className="max-w-full truncate" title={horizontal ? undefined : label}>
        {label}
      </span>
      {horizontal && badgeLabel ? (
        <span
          className="ml-auto shrink-0 rounded-full bg-warning-subtle px-1.5 font-mono text-micro font-medium text-warning"
          data-testid="nav-item-badge"
        >
          {badgeLabel}
        </span>
      ) : null}
    </button>
  );
}
