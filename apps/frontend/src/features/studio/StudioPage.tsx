/**
 * The image side of the product, as a landing rather than a promise.
 *
 * Two ways in and a look at what came out: creating an image happens in the
 * chat, where the model and its tools already live, so this hands over to the
 * composer instead of growing a second generation surface. The recent strip is
 * the gallery's own query and the gallery's own tiles — the first page, which
 * the gallery has usually already cached.
 */

import type { GalleryItem } from '@mangostudio/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { Image, ImagePlus, LayoutGrid } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionCard } from '@/components/ui/SectionCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { GalleryLightbox } from '@/features/gallery/components/GalleryLightbox';
import { GalleryTile } from '@/features/gallery/components/GalleryTile';
import { useGalleryQuery } from '@/features/gallery/queries';
import { useI18n } from '@/hooks/use-i18n';
import { useApp } from '@/lib/app-context';

/** One row on the widest layout, and never a second page's worth of scrolling. */
const RECENT_LIMIT = 4;

export function StudioPage() {
  const { t } = useI18n();
  const [selectedImage, setSelectedImage] = useState<GalleryItem | null>(null);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-8 sm:py-8">
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="rounded-2xl bg-primary-container p-2.5 text-on-primary-container sm:p-3">
            <Image size={24} />
          </div>
          <div className="min-w-0">
            <h1 className="font-headline text-2xl font-bold text-on-background sm:text-3xl">
              {t.studio.title}
            </h1>
            <p className="text-sm text-on-surface-variant/70">{t.studio.subtitle}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <GenerateCard />
          <GalleryCard />
        </div>

        <RecentImages onView={setSelectedImage} />
      </div>

      <GalleryLightbox item={selectedImage} onClose={() => setSelectedImage(null)} />
    </div>
  );
}

/**
 * Hands the conversation over with the image tool already pressed.
 *
 * The intent lives on the app state above the router, so setting it here and
 * navigating leaves the composer in exactly the state the chip would have put
 * it in — no draft text, because the sentence is the user's to write.
 */
function GenerateCard() {
  const { t } = useI18n();
  const { setImageToolIntent } = useApp();
  const navigate = useNavigate();

  return (
    <SectionCard label={t.studio.generate.label} className="justify-between">
      <p className="text-sm text-on-surface-variant">{t.studio.generate.description}</p>
      <Button
        onClick={() => {
          setImageToolIntent(true);
          void navigate({ to: '/' });
        }}
        className="self-start"
      >
        <ImagePlus size={16} />
        {t.studio.generate.action}
      </Button>
    </SectionCard>
  );
}

function GalleryCard() {
  const { t } = useI18n();

  return (
    <SectionCard label={t.studio.gallery.label} className="justify-between">
      <p className="text-sm text-on-surface-variant">{t.studio.gallery.description}</p>
      <Link
        to="/gallery"
        className="inline-flex items-center gap-2 self-start rounded-lg bg-surface-container-high px-4 py-2 text-sm font-bold text-on-surface transition-colors hover:bg-surface-container-highest"
      >
        <LayoutGrid size={16} />
        {t.studio.gallery.action}
      </Link>
    </SectionCard>
  );
}

/**
 * The newest few images, from the gallery's own infinite query.
 *
 * The same query key as `/gallery`, so arriving from there costs no request and
 * a generation that invalidates one updates the other.
 */
function RecentImages({ onView }: { onView: (item: GalleryItem) => void }) {
  const { t } = useI18n();
  const { data, status } = useGalleryQuery();
  const items = data?.pages[0]?.items.slice(0, RECENT_LIMIT) ?? [];

  return (
    <SectionCard
      label={t.studio.recent.label}
      action={
        items.length > 0 ? (
          <Link
            to="/gallery"
            className="text-xs font-medium text-primary transition-opacity hover:opacity-80"
          >
            {t.studio.recent.viewAll}
          </Link>
        ) : null
      }
    >
      {status === 'pending' ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: RECENT_LIMIT }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
            <Skeleton key={index} className="aspect-square rounded-2xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Image size={32} className="opacity-50" />}
          title={t.studio.recent.empty}
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {items.map((item) => (
            <GalleryTile key={item.id} item={item} onView={onView} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}
