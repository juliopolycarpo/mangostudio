import type { LucideIcon } from 'lucide-react';
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
        'w-full rounded-lg transition-all duration-200',
        horizontal
          ? 'flex items-center gap-3 px-4 py-3 text-left'
          : 'flex flex-col items-center justify-center gap-1 p-2 text-xs font-medium',
        active
          ? 'text-primary bg-surface-container-high'
          : 'text-on-surface/70 hover:bg-surface-container-high hover:text-on-surface'
      )}
    >
      <Icon size={horizontal ? ICON_MD : ICON_LG} className="shrink-0" />
      <span
        className={cn('truncate', horizontal && 'font-label font-medium text-sm')}
        title={horizontal ? undefined : label}
      >
        {label}
      </span>
      {horizontal && badgeLabel ? (
        <span
          className="ml-auto shrink-0 rounded-full bg-warning/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-warning"
          data-testid="nav-item-badge"
        >
          {badgeLabel}
        </span>
      ) : null}
    </button>
  );
}
