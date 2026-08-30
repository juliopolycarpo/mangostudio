import { createFileRoute } from '@tanstack/react-router';
import { galleryListQueryOptions } from '@/features/gallery/queries';
import { StudioPage } from '@/features/studio/StudioPage';

export const Route = createFileRoute('/_authenticated/studio')({
  // The recent strip's page, prefetched into the same cache `/gallery` reads,
  // so moving between the two costs nothing either way.
  loader: ({ context: { queryClient } }) =>
    queryClient.prefetchInfiniteQuery(galleryListQueryOptions()),
  component: StudioPage,
});
