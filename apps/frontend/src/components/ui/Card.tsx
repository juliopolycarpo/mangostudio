import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface CardProps {
  variant?: 'glass' | 'solid';
  /**
   * Set `false` when the card brings its own padding in `className`. The
   * default is responsive, and `cn` can only drop the half of it that shares a
   * breakpoint with the override — a bare `p-4` would still be `p-8` from `sm`
   * up. Saying so here beats writing `p-4 sm:p-4` at the call site.
   */
  padded?: boolean;
  className?: string;
  children: ReactNode;
}

const variantStyles: Record<NonNullable<CardProps['variant']>, string> = {
  glass: 'glass-panel',
  solid: 'bg-surface-container-high',
};

/**
 * The app's panel surface: rounded, hairline-bordered, padded.
 *
 * Padding is `p-5` before `sm` and `p-8` from there up. A flat `p-8` spent 64px
 * of a 375px screen on margins, which is why nearly every settings page passes
 * its own — and why those overrides have to actually win, below `sm` as well as
 * above it. `cn` is load-bearing for that: string concatenation left the
 * winner to Tailwind's emission order, so a call site's `p-4` lost to the
 * base `p-8` while its `sm:p-6` won, and a card asked for compact padding got
 * it in exactly one direction.
 *
 * // Usage: <Card className="space-y-4 p-4 sm:p-6">…</Card>
 */
export function Card({ variant = 'solid', padded = true, className, children }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-outline-variant/10',
        padded && 'p-5 sm:p-8',
        variantStyles[variant],
        className
      )}
    >
      {children}
    </div>
  );
}
