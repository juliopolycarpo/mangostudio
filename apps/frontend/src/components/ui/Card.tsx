import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface CardProps {
  /**
   * Set `false` when the card brings its own padding in `className`. The
   * default is responsive, and `cn` can only drop the half of it that shares a
   * breakpoint with the override — a bare `p-4` would still be `p-6` from `sm`
   * up. Saying so here beats writing `p-4 sm:p-4` at the call site.
   */
  padded?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * The app's panel surface: a flat `surface` with a hairline, no shadow. The
 * step between `canvas` and `surface` plus the border is the whole hierarchy.
 *
 * Padding is `p-4` before `sm` and `p-6` from there up. `cn` is load-bearing
 * for call-site overrides: string concatenation left the winner to Tailwind's
 * emission order, so a call site's `p-4` lost to the base while its `sm:p-6`
 * won, and a card asked for compact padding got it in exactly one direction.
 *
 * // Usage: <Card className="space-y-4">…</Card>
 */
export function Card({ padded = true, className, children }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-md border border-stroke bg-surface',
        padded && 'p-4 sm:p-6',
        className
      )}
    >
      {children}
    </div>
  );
}
