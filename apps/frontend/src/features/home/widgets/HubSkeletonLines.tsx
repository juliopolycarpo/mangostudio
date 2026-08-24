import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The hub's loading placeholder: a couple of text-height bars at the widths
 * the real content lands at, so a card does not resize under the user when its
 * query settles.
 */
export function HubSkeletonLines({ lines = 2 }: { lines?: number }) {
  return (
    <div className="space-y-1.5">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          // Index is the identity here: these are interchangeable bars with no
          // data behind them, and nothing ever reorders or removes one.
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder bars have no other identity
          key={index}
          className={index === 0 ? 'h-3.5 w-40' : 'h-3.5 w-56 max-w-full'}
        />
      ))}
    </div>
  );
}
