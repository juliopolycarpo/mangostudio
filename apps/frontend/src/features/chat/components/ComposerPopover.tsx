import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * The surface every popover over the composer wears: a solid `surface-raised`
 * with a hairline and `shadow-popover`, anchored above the control that opened
 * it and left-aligned with it.
 *
 * Spelled out rather than borrowed from `.dropdown-panel`, which clips with an
 * unlayered `overflow: hidden` that no utility can override. These panels
 * scroll (`max-h-96 overflow-y-auto`), so they need a surface that leaves
 * `overflow` to the call site. Padding and spacing belong to the call site for
 * the same reason: a list wants `p-1`, a form wants `p-3`.
 *
 * // Usage: <ComposerPopover className="max-h-96 space-y-3 overflow-y-auto p-3">…</ComposerPopover>
 */
export function ComposerPopover({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'absolute bottom-full left-0 z-50 mb-2 w-80 rounded-md border border-stroke bg-surface-raised shadow-popover',
        className
      )}
      {...props}
    />
  );
}
