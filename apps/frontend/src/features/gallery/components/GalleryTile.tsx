import type { GalleryItem } from '@mangostudio/shared';
import { Download, Maximize2 } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { buildGeneratedImageFilename } from '@/lib/download-filenames';

interface GalleryTileProps {
  readonly item: GalleryItem;
  /** Opens the full image. The tile does not own the lightbox it opens. */
  readonly onView: (item: GalleryItem) => void;
}

/**
 * One generated image, with its prompt and its two actions under a hover
 * gradient.
 *
 * Its own component because the studio landing shows the same images as the
 * gallery does, and a second copy of this markup would be two tiles that drift
 * apart one styling change at a time.
 *
 * // Usage: <GalleryTile item={item} onView={setSelectedImage} />
 */
export function GalleryTile({ item, onView }: GalleryTileProps) {
  const { t } = useI18n();

  return (
    <div className="group relative aspect-square rounded-2xl overflow-hidden bg-surface-container-high border border-outline-variant/20 shadow-sm hover:shadow-xl transition-all duration-300">
      <img
        src={item.imageUrl}
        alt={item.prompt}
        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
        referrerPolicy="no-referrer"
        loading="lazy"
        decoding="async"
      />

      {/*
        `group-focus-within` and not `group-hover` alone: the two controls below
        are tabbable, so revealing them on hover only hands a keyboard user a
        focus ring on something invisible.
      */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-4">
        <p className="text-white text-sm line-clamp-3 font-medium mb-3 drop-shadow-md">
          {item.prompt}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onView(item)}
            className="p-2 bg-white/20 hover:bg-white/30 backdrop-blur-md rounded-lg text-white transition-colors flex-1 flex items-center justify-center gap-2"
          >
            <Maximize2 size={16} />
            <span className="text-xs font-bold uppercase tracking-wider">{t.gallery.view}</span>
          </button>
          {/* Icon-only, so the label is the only name a screen reader can read out. */}
          <a
            href={item.imageUrl}
            download={buildGeneratedImageFilename(t.common.downloadFilenamePrefix, item.id)}
            target="_blank"
            rel="noreferrer"
            aria-label={t.gallery.downloadImage}
            className="p-2 bg-primary hover:bg-primary/90 rounded-lg text-on-primary transition-colors flex items-center justify-center"
          >
            <Download size={16} />
          </a>
        </div>
      </div>
    </div>
  );
}
