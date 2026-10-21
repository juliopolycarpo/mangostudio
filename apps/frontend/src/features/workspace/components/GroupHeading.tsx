import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { MicroLabel } from '@/components/ui/MicroLabel';

interface GroupHeadingProps {
  readonly title: string;
  /** How many rows the group holds; omit for a group whose size is not worth stating. */
  readonly count?: number;
  /** Icon buttons for the whole group, pushed to the trailing edge. */
  readonly children?: ReactNode;
}

/**
 * A group's heading row: the micro-label, a neutral count and the group-wide
 * actions. The Repository panel draws it for the change groups and for the
 * worktrees, so the two read as the same kind of list.
 */
export function GroupHeading({ title, count, children }: GroupHeadingProps) {
  return (
    <div className="mb-2 flex min-h-7 items-center gap-2">
      {/* The count lives inside the heading so the group's accessible name says
          how many rows it holds, not just what it is called. */}
      <MicroLabel as="h3" className="flex items-center gap-2">
        {title}
        {count === undefined ? null : <Badge>{count}</Badge>}
      </MicroLabel>
      {children ? <div className="ml-auto flex items-center gap-1">{children}</div> : null}
    </div>
  );
}
