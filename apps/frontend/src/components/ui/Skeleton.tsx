import { cn } from '@/lib/utils';

interface SkeletonProps {
  className?: string;
}

/**
 * Pulsing placeholder block. Shape and size come from the call site
 * (`aspect-square rounded-md`, `h-4 w-32`); the pulse is `.skeleton-block`.
 */
export function Skeleton({ className }: SkeletonProps) {
  return <div aria-hidden="true" className={cn('skeleton-block', className)} />;
}
