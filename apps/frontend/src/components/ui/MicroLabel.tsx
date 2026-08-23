import type { ElementType, HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface MicroLabelProps extends HTMLAttributes<HTMLElement> {
  /** Semantic element — a heading for sections, the default span inline. */
  as?: ElementType;
}

/**
 * Mono uppercase section label (`WORKSPACE`, `AGENTS`). Typography comes from
 * the `.micro-label` component class; layout stays with the call site.
 */
export function MicroLabel({ as: Tag = 'span', className, children, ...props }: MicroLabelProps) {
  return (
    <Tag className={cn('micro-label', className)} {...props}>
      {children}
    </Tag>
  );
}
