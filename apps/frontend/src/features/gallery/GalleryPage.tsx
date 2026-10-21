import type { GalleryItem } from '@mangostudio/shared/types';
import { LayoutGrid } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_LG } from '@/lib/icon-sizes';
import { GalleryLightbox } from './components/GalleryLightbox';
import { GalleryTile } from './components/GalleryTile';
import { useGalleryQuery } from './queries';

export function GalleryPage() {
  const [selectedImage, setSelectedImage] = useState<GalleryItem | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, status } = useGalleryQuery();

  const items = data?.pages.flatMap((page) => page.items) || [];

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { threshold: 0.1 }
    );

    if (loadMoreRef.current) {
      observer.observe(loadMoreRef.current);
    }

    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-4 sm:gap-8 sm:p-6">
      <h1 className="shrink-0 text-title font-semibold text-fg">{t.gallery.title}</h1>

      {status === 'pending' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 pb-12">
          {Array.from({ length: 8 }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
            <Skeleton key={index} className="aspect-square rounded-md" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<LayoutGrid size={ICON_LG} />}
          title={t.gallery.empty}
          className="flex-1 py-20"
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 pb-12">
          {items.map((item) => (
            <GalleryTile key={item.id} item={item} onView={setSelectedImage} />
          ))}

          <div ref={loadMoreRef} className="col-span-full flex h-10 items-center justify-center">
            {isFetchingNextPage && <Spinner size="md" label={t.common.loading} />}
          </div>
        </div>
      )}

      <GalleryLightbox item={selectedImage} onClose={() => setSelectedImage(null)} />
    </div>
  );
}
