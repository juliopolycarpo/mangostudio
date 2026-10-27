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

/**
 * Two columns from the phone up, the density of Studio's recent strip, which
 * draws the same `GalleryTile`: one 358px tile per row made a dozen images a
 * dozen screens. The skeleton and the loaded grid share it so nothing jumps
 * when the first page lands.
 */
const GALLERY_GRID = 'grid grid-cols-2 gap-3 pb-12 sm:gap-6 lg:grid-cols-3 xl:grid-cols-4';

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
        <div className={GALLERY_GRID}>
          {Array.from({ length: 8 }, (_, index) => (
            // static placeholder list
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
        <div className={GALLERY_GRID}>
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
