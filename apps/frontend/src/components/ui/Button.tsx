import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

type ButtonVariant = 'primary' | 'secondary' | 'subtle' | 'subtle-danger' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children: ReactNode;
}

/**
 * A disabled button is a neutral grey in every variant — the way WinUI and
 * libadwaita draw one — rather than the variant's colour faded by opacity. A
 * button that is only loading keeps its colour: `aria-busy` is what tells the
 * two apart, and the spinner is the signal.
 */
const DISABLED_NEUTRAL =
  '[&:disabled:not([aria-busy=true])]:border-transparent [&:disabled:not([aria-busy=true])]:bg-fill-selected [&:disabled:not([aria-busy=true])]:text-fg-subtle';

/**
 * Hover and press are written with `not-disabled:` rather than `enabled:` so the
 * same classes work on an anchor styled as a button (`buttonClassName`), which
 * `:enabled` never matches.
 */
const variantStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-on-accent not-disabled:hover:bg-accent-hover not-disabled:active:bg-accent-pressed',
  secondary:
    'border border-stroke bg-control text-fg not-disabled:hover:bg-control-hover not-disabled:active:bg-control-pressed',
  subtle: 'text-fg not-disabled:hover:bg-fill-hover not-disabled:active:bg-fill-pressed',
  // A destructive action that is not the final confirmation — "Remove" on a row,
  // "Revoke" in a list. Quiet until hovered.
  'subtle-danger':
    'text-danger not-disabled:hover:bg-danger-subtle not-disabled:active:bg-danger-subtle',
  // Confirming something that deletes a user's files should not look like
  // confirming anything else.
  danger: 'bg-danger-solid text-on-danger not-disabled:hover:brightness-110',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'h-7 px-2 text-xs',
  md: 'h-8 px-3 text-sm',
  lg: 'h-10 px-4 text-sm',
  icon: 'size-8 p-0 text-sm',
  'icon-sm': 'size-7 p-0 text-sm',
};

/**
 * The classes a `Button` wears, for the few things that must look like one but
 * cannot be a `<button>`: a router `<Link>`, a download `<a>`.
 *
 * // Usage: <Link to="/gallery" className={buttonClassName('secondary', 'sm')}>…</Link>
 */
export function buttonClassName(variant: ButtonVariant = 'primary', size: ButtonSize = 'md') {
  return cn(
    'inline-flex items-center justify-center gap-2 rounded-sm font-medium transition-colors cursor-pointer disabled:cursor-not-allowed aria-busy:cursor-progress',
    variantStyles[variant],
    DISABLED_NEUTRAL,
    sizeStyles[size]
  );
}

/**
 * The one button. Heights are the platform's own rhythm (28/32/40px), weight is
 * 500, and nothing about it floats: no shadow, no scale on press, no glow in
 * the variant's colour. Hover and press change only the fill.
 *
 * // Usage: <Button variant="secondary" size="sm">{t.common.cancel}</Button>
 */
export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonClassName(variant, size), className)}
      {...props}
    >
      {loading && (
        <span className="size-4 rounded-full border-2 border-current border-t-transparent animate-spin shrink-0" />
      )}
      {children}
    </button>
  );
}
