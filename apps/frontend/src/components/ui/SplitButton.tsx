import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './Button';
import { Menu } from './Menu';

interface SplitButtonProps {
  readonly onClick: () => void;
  readonly disabled?: boolean;
  /**
   * Kept separate from `disabled`: the menu holds actions with their own
   * preconditions, so a blocked primary action must not seal them off.
   */
  readonly menuDisabled?: boolean;
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
 *
 * The halves stay one colour. While the primary half is unavailable it is the
 * neutral grey every disabled button turns, so the chevron drops to `secondary`
 * with it rather than staying the only mango in the region; a primary half that
 * is merely loading keeps its accent, and the chevron keeps it too.
 */
export function SplitButton({
  onClick,
  disabled = false,
  menuDisabled = false,
  loading = false,
  menuLabel,
  open,
  onOpenChange,
  className,
  menu,
  children,
}: SplitButtonProps) {
  const primaryNeutral = disabled && !loading;

  return (
    <div className={cn('flex min-w-0 items-stretch', className)}>
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
            variant={primaryNeutral ? 'secondary' : 'primary'}
            aria-label={menuLabel}
            title={menuLabel}
            disabled={menuDisabled}
            // While the primary half loads, its colour must carry across the
            // divider even when the menu is blocked too: `aria-busy` is what
            // keeps a disabled button out of the grey.
            aria-busy={loading || undefined}
            // The secondary variant brings its own `stroke` border, which an
            // unconditional accent edge would repaint on all four sides.
            className={cn(
              'h-full rounded-l-none',
              !primaryNeutral && 'border-l border-accent-pressed'
            )}
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
