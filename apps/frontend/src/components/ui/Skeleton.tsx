import { cn } from '@/lib/utils';

interface SkeletonProps {
  className?: string;
}

/**
 * Shimmer placeholder block. Shape and size come from the call site
 * (`aspect-square rounded-xl`, `h-4 w-32`); the shimmer is `.skeleton-block`.
 */
export function Skeleton({ className }: SkeletonProps) {
  return <div aria-hidden="true" className={cn('skeleton-block', className)} />;
}
