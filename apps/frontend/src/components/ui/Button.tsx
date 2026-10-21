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
 * A disabled button is a neutral grey rather than the variant's colour faded by
 * opacity — the way WinUI and libadwaita draw one. A button that is only loading
 * keeps its colour: `aria-busy` is what tells the two apart, and the spinner is
 * the signal.
 *
 * Two looks, because the variants split in two. The filled ones (`primary`,
 * `secondary`, `danger`) turn into a grey tile. The quiet ones (`subtle`,
 * `subtle-danger`) have no tile to turn grey: giving them `fill-selected` drew
 * the inactive button as the hovered or selected one, the most prominent thing in
 * its row, so they only lose their text colour. Decision 14 records the split.
 *
 * Each string spells out its selector in full because Tailwind finds classes by
 * scanning for them; building one from a shared prefix would compile to nothing.
 */
const DISABLED_TILE =
  '[&:disabled:not([aria-busy=true])]:border-transparent [&:disabled:not([aria-busy=true])]:bg-fill-selected [&:disabled:not([aria-busy=true])]:text-fg-subtle';
const DISABLED_TEXT = '[&:disabled:not([aria-busy=true])]:text-fg-subtle';

/**
 * Hover and press are written with `not-disabled:` rather than `enabled:` so the
 * same classes work on an anchor styled as a button (`buttonClassName`), which
 * `:enabled` never matches.
 */
const variantStyles: Record<ButtonVariant, string> = {
  primary: `bg-accent text-on-accent not-disabled:hover:bg-accent-hover not-disabled:active:bg-accent-pressed ${DISABLED_TILE}`,
  secondary: `border border-stroke bg-control text-fg not-disabled:hover:bg-control-hover not-disabled:active:bg-control-pressed ${DISABLED_TILE}`,
  subtle: `text-fg not-disabled:hover:bg-fill-hover not-disabled:active:bg-fill-pressed ${DISABLED_TEXT}`,
  // A destructive action that is not the final confirmation — "Remove" on a
  // row, "Revoke" in a list. `fg-muted` at rest, because these repeat: a list
  // of rows each ending in a red trash can is a column of red that outshouts
  // the content it sits beside. The verb turns `danger` text on a
  // `danger-subtle` fill once the pointer, the keyboard or a press reaches it,
  // which is when it is about to happen. Focus is `focus-visible`, not `focus`:
  // a mouse click leaves a button focused, and the row would stay tinted after
  // it. A disabled one is greyed: the selector above outranks it.
  'subtle-danger': `text-fg-muted not-disabled:hover:bg-danger-subtle not-disabled:hover:text-danger not-disabled:focus-visible:bg-danger-subtle not-disabled:focus-visible:text-danger not-disabled:active:bg-danger-subtle not-disabled:active:text-danger ${DISABLED_TEXT}`,
  // Confirming something that deletes a user's files should not look like
  // confirming anything else.
  danger: `bg-danger-solid text-on-danger not-disabled:hover:brightness-110 ${DISABLED_TILE}`,
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
    sizeStyles[size]
  );
}

/**
 * The one button. Heights are the platform's own rhythm (28/32/40px), weight is
 * 500, and nothing about it floats: no shadow, no scale on press, no glow in
 * the variant's colour. Hover and press change only the fill, except on
 * `subtle-danger`, whose text also turns `danger` on hover, keyboard focus and press
 * (decision 22).
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
