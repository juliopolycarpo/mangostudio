import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'subtle' | 'danger';
  size?: 'sm' | 'md' | 'lg' | 'icon';
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

const variantStyles: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary:
    'bg-accent text-on-accent enabled:hover:bg-accent-hover enabled:active:bg-accent-pressed',
  secondary:
    'border border-stroke bg-control text-fg enabled:hover:bg-control-hover enabled:active:bg-control-pressed',
  subtle: 'text-fg enabled:hover:bg-fill-hover enabled:active:bg-fill-pressed',
  // Confirming something that deletes a user's files should not look like
  // confirming anything else.
  danger: 'bg-danger-solid text-on-danger enabled:hover:brightness-110',
};

const sizeStyles: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'h-7 px-2 text-xs',
  md: 'h-8 px-3 text-sm',
  lg: 'h-10 px-4 text-sm',
  icon: 'size-8 p-0 text-sm',
};

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
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-sm font-medium transition-colors cursor-pointer disabled:cursor-not-allowed aria-busy:cursor-progress',
        variantStyles[variant],
        DISABLED_NEUTRAL,
        sizeStyles[size],
        className
      )}
      {...props}
    >
      {loading && (
        <span className="size-4 rounded-full border-2 border-current border-t-transparent animate-spin shrink-0" />
      )}
      {children}
    </button>
  );
}
