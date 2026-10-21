import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface ImageActionBarProps {
  children: ReactNode;
  className?: string;
}

/**
 * The bar of actions that surfaces over an image while it is hovered or holds
 * focus. A floating surface, so it is solid `surface-raised` with a hairline and
 * the popover shadow — never a frosted panel over the picture.
 *
 * The caller owns the positioning context: wrap the image and this bar in a
 * `group relative` element.
 *
 * // Usage: <div className="group relative"><img … /><ImageActionBar>…</ImageActionBar></div>
 */
export function ImageActionBar({ children, className }: ImageActionBarProps) {
  return (
    <div
      className={cn(
        'absolute inset-x-3 bottom-3 flex items-center justify-between gap-2 rounded-md border border-stroke bg-surface-raised p-1 opacity-0 shadow-popover transition-opacity group-focus-within:opacity-100 group-hover:opacity-100',
        className
      )}
    >
      {children}
    </div>
  );
}
