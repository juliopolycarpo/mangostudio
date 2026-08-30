import type { GalleryItem } from '@mangostudio/shared';
import { LayoutGrid, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useI18n } from '@/hooks/use-i18n';
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
    <div className="p-4 sm:p-6 md:p-8 space-y-6 sm:space-y-8 h-full flex flex-col overflow-y-auto">
      <div className="flex items-center gap-3 sm:gap-4 mb-6 sm:mb-8 shrink-0">
        <div className="p-3 bg-primary-container text-on-primary-container rounded-2xl">
          <LayoutGrid size={24} />
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold font-headline text-on-background">
          {t.gallery.title}
        </h1>
      </div>

      {status === 'pending' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 pb-12">
          {Array.from({ length: 8 }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
            <Skeleton key={index} className="aspect-square rounded-2xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<LayoutGrid size={48} className="opacity-50" />}
          title={t.gallery.empty}
          className="flex-1 py-20"
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 pb-12">
          {items.map((item) => (
            <GalleryTile key={item.id} item={item} onView={setSelectedImage} />
          ))}

          <div ref={loadMoreRef} className="col-span-full h-10 flex justify-center items-center">
            {isFetchingNextPage && <Loader2 className="w-6 h-6 animate-spin text-primary" />}
          </div>
        </div>
      )}

      <GalleryLightbox item={selectedImage} onClose={() => setSelectedImage(null)} />
    </div>
  );
}
