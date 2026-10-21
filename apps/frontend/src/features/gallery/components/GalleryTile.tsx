import type { GalleryItem } from '@mangostudio/shared/types';
import { Download } from 'lucide-react';
import { buttonClassName } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { buildGeneratedImageFilename } from '@/lib/download-filenames';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

interface GalleryTileProps {
  readonly item: GalleryItem;
  /** Opens the full image. The tile does not own the lightbox it opens. */
  readonly onView: (item: GalleryItem) => void;
  /**
   * Image only, no caption bar and no download link. For a strip of small tiles
   * (the studio's recent images) where a three-line prompt would cover most of
   * the thumbnail; the lightbox the tile opens carries both.
   */
  readonly compact?: boolean;
}

/**
 * One generated image. The image itself is the control that opens it, so a tap
 * anywhere on the tile works on a screen with no hover; on a pointer or a
 * keyboard, a caption bar over the foot of the tile adds the prompt and a
 * download link.
 *
 * Its own component because the studio landing shows the same images as the
 * gallery does, and a second copy of this markup would be two tiles that drift
 * apart one styling change at a time.
 *
 * Three decisions in the structure, each of which is easy to undo by accident:
 * - The wrapper carries `group` and `relative` but no `overflow-hidden`; the
 *   button inside it clips the image. The global focus ring sits 2px outside the
 *   element it belongs to, and a clipping wrapper would cut it off.
 * - The caption bar is a sibling of the button, not inside it: the download link
 *   is a second interactive element and may not nest in a button.
 * - The bar does not take pointer events, only the download link does, and only
 *   while the bar is shown. Otherwise the invisible bar swallows taps on the
 *   bottom of the image, and the visible one stops a click on its text from
 *   opening the image. `hover:` is gated to hover-capable pointers, so on touch
 *   the link never takes events and the tap reaches the image.
 *
 * The bar is a solid `surface-raised` strip rather than a veil over the image:
 * `scrim` is translucent, so the contrast of text laid on it would depend on
 * whichever picture happens to sit underneath.
 *
 * // Usage: <GalleryTile item={item} onView={setSelectedImage} />
 */
export function GalleryTile({ item, onView, compact = false }: GalleryTileProps) {
  const { t } = useI18n();

  return (
    <div className="group relative aspect-square">
      <button
        type="button"
        onClick={() => onView(item)}
        aria-label={formatMessage(t.gallery.viewImage, { prompt: item.prompt })}
        aria-haspopup="dialog"
        className="block size-full cursor-pointer overflow-hidden rounded-md border border-stroke bg-surface transition-colors group-hover:border-stroke-strong"
      >
        <img
          src={item.imageUrl}
          alt={item.prompt}
          className="size-full object-cover"
          referrerPolicy="no-referrer"
          loading="lazy"
          decoding="async"
        />
      </button>

      {/*
        `group-focus-within` and not `group-hover` alone: the download link is
        tabbable, so revealing it on hover only hands a keyboard user a focus
        ring on something invisible.
      */}
      {compact ? null : (
        <div className="pointer-events-none absolute inset-x-px bottom-px flex items-start gap-3 rounded-b-sm border-t border-stroke bg-surface-raised p-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <p className="line-clamp-3 min-w-0 flex-1 text-sm text-fg">{item.prompt}</p>
          {/* Icon-only, so the label is the only name a screen reader can read out. */}
          <a
            href={item.imageUrl}
            download={buildGeneratedImageFilename(t.common.downloadFilenamePrefix, item.id)}
            target="_blank"
            rel="noreferrer"
            aria-label={t.gallery.downloadImage}
            className={cn(
              buttonClassName('secondary', 'icon-sm'),
              'pointer-events-none shrink-0 group-hover:pointer-events-auto group-focus-within:pointer-events-auto'
            )}
          >
            <Download size={ICON_MD} />
          </a>
        </div>
      )}
    </div>
  );
}
