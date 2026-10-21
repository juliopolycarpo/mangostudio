import type { GalleryItem } from '@mangostudio/shared/types';
import { Download, Maximize2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { buildGeneratedImageFilename } from '@/lib/download-filenames';
import { ICON_MD } from '@/lib/icon-sizes';

interface GalleryTileProps {
  readonly item: GalleryItem;
  /** Opens the full image. The tile does not own the lightbox it opens. */
  readonly onView: (item: GalleryItem) => void;
}

/**
 * One generated image, with its prompt and its two actions in a caption bar
 * that appears over the foot of the tile.
 *
 * Its own component because the studio landing shows the same images as the
 * gallery does, and a second copy of this markup would be two tiles that drift
 * apart one styling change at a time.
 *
 * The bar is a solid `surface-raised` strip rather than a veil over the image:
 * `scrim` is translucent, so the contrast of text laid on it would depend on
 * whichever picture happens to sit underneath.
 *
 * // Usage: <GalleryTile item={item} onView={setSelectedImage} />
 */
export function GalleryTile({ item, onView }: GalleryTileProps) {
  const { t } = useI18n();

  return (
    <div className="group relative aspect-square overflow-hidden rounded-md border border-stroke bg-surface">
      <img
        src={item.imageUrl}
        alt={item.prompt}
        className="size-full object-cover"
        referrerPolicy="no-referrer"
        loading="lazy"
        decoding="async"
      />

      {/*
        `group-focus-within` and not `group-hover` alone: the two controls below
        are tabbable, so revealing them on hover only hands a keyboard user a
        focus ring on something invisible.
      */}
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-3 border-t border-stroke bg-surface-raised p-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <p className="line-clamp-3 text-sm text-fg">{item.prompt}</p>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => onView(item)} className="flex-1">
            <Maximize2 size={ICON_MD} />
            {t.gallery.view}
          </Button>
          {/* Icon-only, so the label is the only name a screen reader can read out. */}
          <a
            href={item.imageUrl}
            download={buildGeneratedImageFilename(t.common.downloadFilenamePrefix, item.id)}
            target="_blank"
            rel="noreferrer"
            aria-label={t.gallery.downloadImage}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm border border-stroke bg-control text-fg transition-colors hover:bg-control-hover active:bg-control-pressed"
          >
            <Download size={ICON_MD} />
          </a>
        </div>
      </div>
    </div>
  );
}
