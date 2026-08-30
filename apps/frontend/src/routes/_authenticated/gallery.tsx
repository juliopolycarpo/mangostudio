import { createFileRoute } from '@tanstack/react-router';
import { galleryListQueryOptions } from '@/features/gallery/queries';

export const Route = createFileRoute('/_authenticated/gallery')({
  loader: ({ context: { queryClient } }) =>
    queryClient.prefetchInfiniteQuery(galleryListQueryOptions()),
});
