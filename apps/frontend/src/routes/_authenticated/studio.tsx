import { createFileRoute } from '@tanstack/react-router';
import { galleryListQueryOptions } from '@/features/gallery/queries';

export const Route = createFileRoute('/_authenticated/studio')({
  // The recent strip's page, fetched into the same cache `/gallery` reads, so
  // moving between the two costs nothing either way.
  //
  // Only when that cache is cold. `prefetchInfiniteQuery` on an existing
  // infinite query replays every page it already holds, one request at a time,
  // with the loader waiting on all of them — so arriving from a deeply browsed
  // gallery would pay a request per page to show four images, and get slower
  // the more the user had scrolled. A warm cache already holds those four.
  //
  // Not `pages: 1`, which would bound the fetch by discarding the rest of the
  // gallery's pages from the shared cache; and not `ensureInfiniteQueryData`,
  // which rejects on a failed fetch and would send a cold-cache error to the
  // route's error boundary instead of the strip's own "could not load" state.
  loader: ({ context: { queryClient } }) => {
    const options = galleryListQueryOptions();
    if (queryClient.getQueryData(options.queryKey) !== undefined) return;
    return queryClient.prefetchInfiniteQuery(options);
  },
});
