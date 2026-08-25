import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The hub's loading placeholder: two text-height bars at the widths the real
 * content lands at, so a card does not resize under the user when its query
 * settles.
 *
 * Two, not a count: the widths are a short line over a long one, which is the
 * shape every hub card's content has and not a pattern a third bar extends.
 */
export function HubSkeletonLines() {
  return (
    <div className="space-y-1.5">
      <Skeleton className="h-3.5 w-40" />
      <Skeleton className="h-3.5 w-56 max-w-full" />
    </div>
  );
}
