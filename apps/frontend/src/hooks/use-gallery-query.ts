import { useInfiniteQuery } from '@tanstack/react-query';
import { client } from '../lib/api-client';
import type { GalleryItem } from '@mangostudio/shared';

export const galleryKeys = {
  all: ['gallery'] as const,
  lists: () => [...galleryKeys.all, 'list'] as const,
};

export function useGalleryQuery() {
  return useInfiniteQuery({
    queryKey: galleryKeys.lists(),
    queryFn: async ({ pageParam }) => {
      const query = pageParam ? { cursor: pageParam, limit: '20' } : { limit: '20' };
      const { data, error } = await client.api.messages.images.get({ query });
      if (error) throw new Error(error.value as string);
      return data as { items: GalleryItem[]; nextCursor: string | null };
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}
