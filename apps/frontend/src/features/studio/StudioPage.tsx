/**
 * The image side of the product, as a landing rather than a promise.
 *
 * Two ways in and a look at what came out: creating an image happens in the
 * chat, where the model and its tools already live, so this hands over to the
 * composer instead of growing a second generation surface. The recent strip is
 * the gallery's own query and the gallery's own tiles — the first page, which
 * the gallery has usually already cached.
 */

import type { GalleryItem } from '@mangostudio/shared/types';
import { Link, useNavigate } from '@tanstack/react-router';
import { Image, ImagePlus, LayoutGrid } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionCard } from '@/components/ui/SectionCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { GalleryLightbox } from '@/features/gallery/components/GalleryLightbox';
import { GalleryTile } from '@/features/gallery/components/GalleryTile';
import { useGalleryQuery } from '@/features/gallery/queries';
import { useI18n } from '@/hooks/use-i18n';
import { useApp } from '@/lib/app-context';
import { ICON_LG, ICON_MD } from '@/lib/icon-sizes';

/** One row on the widest layout, and never a second page's worth of scrolling. */
const RECENT_LIMIT = 4;

export function StudioPage() {
  const { t } = useI18n();
  const [selectedImage, setSelectedImage] = useState<GalleryItem | null>(null);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-8 px-4 py-6 sm:px-8 sm:py-8">
        <div className="min-w-0 space-y-1">
          <h1 className="text-title font-semibold text-fg">{t.studio.title}</h1>
          <p className="text-sm text-fg-muted">{t.studio.subtitle}</p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
      <p className="text-sm text-fg-muted">{t.studio.generate.description}</p>
      <Button
        onClick={() => {
          setImageToolIntent(true);
          void navigate({ to: '/' });
        }}
        className="self-start"
      >
        <ImagePlus size={ICON_MD} />
        {t.studio.generate.action}
      </Button>
    </SectionCard>
  );
}

function GalleryCard() {
  const { t } = useI18n();

  return (
    <SectionCard label={t.studio.gallery.label} className="justify-between">
      <p className="text-sm text-fg-muted">{t.studio.gallery.description}</p>
      <Link
        to="/gallery"
        className="inline-flex h-8 items-center gap-2 self-start rounded-sm border border-stroke bg-control px-3 text-sm font-medium text-fg transition-colors hover:bg-control-hover active:bg-control-pressed"
      >
        <LayoutGrid size={ICON_MD} />
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
          <Link to="/gallery" className="text-xs font-medium text-accent-fg hover:underline">
            {t.studio.recent.viewAll}
          </Link>
        ) : null
      }
    >
      <RecentStrip status={status} items={items} onView={onView} />
    </SectionCard>
  );
}

/**
 * The strip's four states, each said out loud.
 *
 * A failed request is its own answer and not the empty one: reporting an
 * unreachable gallery as "nothing generated yet" tells the user their work is
 * gone when it is only out of reach.
 */
function RecentStrip({
  status,
  items,
  onView,
}: {
  status: ReturnType<typeof useGalleryQuery>['status'];
  items: readonly GalleryItem[];
  onView: (item: GalleryItem) => void;
}) {
  const { t } = useI18n();

  if (status === 'pending') {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: RECENT_LIMIT }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
          <Skeleton key={index} className="aspect-square rounded-md" />
        ))}
      </div>
    );
  }

  if (status === 'error') {
    return <Callout tone="danger">{t.studio.recent.error}</Callout>;
  }

  if (items.length === 0) {
    return <EmptyState icon={<Image size={ICON_LG} />} title={t.studio.recent.empty} />;
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((item) => (
        <GalleryTile key={item.id} item={item} onView={onView} compact />
      ))}
    </div>
  );
}
