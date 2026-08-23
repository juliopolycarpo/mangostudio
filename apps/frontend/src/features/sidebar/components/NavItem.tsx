import type { LucideIcon } from 'lucide-react';
import { ICON_LG, ICON_MD } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

interface NavItemProps {
  icon: LucideIcon;
  label: string;
  active: boolean;
  /** `horizontal` is the desktop rail row; `vertical` the mobile shortcut tile. */
  orientation?: 'horizontal' | 'vertical';
  onClick: () => void;
}

/** One sidebar navigation entry, shared by the desktop rail and the mobile grid. */
export function NavItem({
  icon: Icon,
  label,
  active,
  orientation = 'horizontal',
  onClick,
}: NavItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'w-full rounded-lg transition-all duration-200',
        orientation === 'horizontal'
          ? 'flex items-center gap-3 px-4 py-3 text-left'
          : 'flex flex-col items-center justify-center gap-1 p-2 text-xs font-medium',
        active
          ? 'text-primary bg-surface-container-high'
          : 'text-on-surface/70 hover:bg-surface-container-high hover:text-on-surface'
      )}
    >
      <Icon size={orientation === 'horizontal' ? ICON_MD : ICON_LG} />
      <span className={orientation === 'horizontal' ? 'font-label font-medium text-sm' : undefined}>
        {label}
      </span>
    </button>
  );
}
