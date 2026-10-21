/**
 * The image side of the product, as a landing rather than a promise.
 *
 * One way in and a look at what came out: creating an image happens in the
 * chat, where the model and its tools already live, so this hands over to the
 * composer instead of growing a second generation surface. The recent strip is
 * the gallery's own query and the gallery's own tiles — the first page, which
 * the gallery has usually already cached — and its "View all" is the way on to
 * the gallery, so the page does not repeat what the sidebar already offers.
 *
 * Centred in a `max-w-6xl` column with Home's own gutters (`px-4 sm:px-6`), so
 * its heading starts at the same x as Home's and the gallery's.
 */

import type { GalleryItem } from '@mangostudio/shared/types';
import { Link, useNavigate } from '@tanstack/react-router';
import { Image, ImagePlus } from 'lucide-react';
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
      <div className="mx-auto w-full max-w-6xl space-y-8 px-4 py-6 sm:px-6 sm:py-8">
        <div className="min-w-0 space-y-1">
          <h1 className="text-title font-semibold text-fg">{t.studio.title}</h1>
          <p className="text-sm text-fg-muted">{t.studio.subtitle}</p>
        </div>

        <GenerateCard />

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
    <SectionCard label={t.studio.generate.label}>
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
          // `inline-flex items-center`: on a touch screen every link is a 44px
          // box, and a plain link in this header floated its text to the top of
          // it, a dozen pixels above the label it sits beside.
          <Link
            to="/gallery"
            className="inline-flex items-center text-xs font-medium text-accent-fg hover:underline"
          >
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
