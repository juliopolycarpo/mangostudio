import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { Menu } from './Menu';

interface SplitButtonProps {
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  /** Accessible name for the chevron that opens the secondary actions. */
  readonly menuLabel: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly className?: string;
  /** `MenuItem` and `MenuSeparator` children for the dropdown. */
  readonly menu: ReactNode;
  readonly children: ReactNode;
}

/**
 * Primary action plus a menu of its variants, sharing one visual button. The
 * two halves are separate controls so the default action stays a single click.
 */
export function SplitButton({
  onClick,
  disabled = false,
  loading = false,
  menuLabel,
  open,
  onOpenChange,
  className = '',
  menu,
  children,
}: SplitButtonProps) {
  return (
    <div className={`flex min-w-0 items-stretch ${className}`}>
      <Button
        type="button"
        size="sm"
        loading={loading}
        disabled={disabled}
        onClick={onClick}
        className="min-w-0 flex-1 rounded-r-none"
      >
        {children}
      </Button>
      <Menu
        open={open}
        onOpenChange={onOpenChange}
        panelClassName="w-60"
        trigger={(triggerProps) => (
          <Button
            type="button"
            size="sm"
            aria-label={menuLabel}
            title={menuLabel}
            disabled={disabled}
            className="h-full rounded-l-none border-l border-on-primary/25"
            {...triggerProps}
          >
            <ChevronDown size={14} />
          </Button>
        )}
      >
        {menu}
      </Menu>
    </div>
  );
}
