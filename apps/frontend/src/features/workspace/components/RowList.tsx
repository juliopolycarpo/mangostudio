import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface RowListProps {
  readonly as?: 'ul' | 'ol';
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * A bordered, divided list of rows: changed files, commits, worktrees. The
 * container is a `rounded-md` hairline box with no fill of its own and the rows
 * are separated by a `stroke` line, so a list inside a panel is never a card
 * nested in a card.
 */
export function RowList({ as: Tag = 'ul', className, children }: RowListProps) {
  return (
    <Tag
      className={cn(
        'divide-y divide-stroke overflow-hidden rounded-md border border-stroke',
        className
      )}
    >
      {children}
    </Tag>
  );
}
