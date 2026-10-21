/**
 * Content blocks the Repository-panel dialogs put in a `Dialog` body: a quoted
 * value and a list of paths, drawn as data and not as prose.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A quoted value inside a dialog — the branch about to be deleted, the stash
 * about to be dropped. Mono on `canvas`, the same recess a tool block's output
 * sits in, so the thing the question is about reads as data and not as prose.
 */
export function DialogCodeBlock({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-md border border-stroke bg-canvas p-2 font-mono text-xs text-fg',
        className
      )}
    >
      {children}
    </div>
  );
}

/** The paths a dialog is about to act on, one per line, scrolling past a handful. */
export function DialogPathList({ paths }: { readonly paths: readonly string[] }) {
  return (
    <DialogCodeBlock className="app-scrollbar max-h-32 overflow-y-auto">
      <ul>
        {paths.map((path) => (
          <li key={path} className="truncate py-0.5" title={path}>
            {path}
          </li>
        ))}
      </ul>
    </DialogCodeBlock>
  );
}
