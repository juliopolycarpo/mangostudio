import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'aria-label'
> {
  /**
   * The accessible name, and the tooltip unless `title` says more: an icon
   * alone says nothing to a screen reader.
   */
  readonly label: string;
  /** `danger` is for the control that deletes: its hover reads as a warning. */
  readonly tone?: 'default' | 'danger';
  /**
   * A refresh under way. Keeps the button's colour and sets `aria-busy` — the
   * spinning icon is the signal — instead of turning the button the neutral
   * grey of a disabled one every time a query refetches.
   */
  readonly busy?: boolean;
  readonly children: ReactNode;
}

/**
 * The 28px icon-only button the panels use in their bars and rows: a `subtle`
 * `Button` with its resting icon in `fg-muted`.
 *
 * // Usage: <IconButton label={labels.refresh} onClick={refresh}><RefreshCw size={ICON_SM} /></IconButton>
 */
export function IconButton({
  label,
  title = label,
  tone = 'default',
  busy = false,
  className,
  children,
  ...props
}: IconButtonProps) {
  return (
    <Button
      type="button"
      variant="subtle"
      size="icon"
      aria-label={label}
      title={title}
      aria-busy={busy || undefined}
      className={cn(
        'size-7 shrink-0 text-fg-muted enabled:hover:text-fg',
        tone === 'danger' && 'enabled:hover:bg-danger-subtle enabled:hover:text-danger',
        className
      )}
      {...props}
    >
      {children}
    </Button>
  );
}
