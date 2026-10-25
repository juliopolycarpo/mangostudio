import type { GalleryItem } from '@mangostudio/shared/types';
import { Download, X } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import * as motion from 'motion/react-m';
import { useCallback, useRef } from 'react';
import { Button, buttonClassName } from '@/components/ui/Button';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { useI18n } from '@/hooks/use-i18n';
import { buildGeneratedImageFilename } from '@/lib/download-filenames';
import { ICON_MD } from '@/lib/icon-sizes';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';
import { cn } from '@/lib/utils';
import { MEDIA_CONTROL_CLASS } from './media-control';

interface GalleryLightboxProps {
  /** The image on screen, or null for "closed" — the exit animation needs both. */
  readonly item: GalleryItem | null;
  readonly onClose: () => void;
}

/**
 * The full image on a dark veil of its own, with its prompt, a way to close it
 * and a download link.
 *
 * The ground is `scrim-media` laid twice, about 91% black. A single 70% veil
 * (the `scrim` a dialog sits on is a 55% / 32% tint, thinner still) left the page
 * behind readable: on a phone the tapped tile reappeared above and below the
 * caption, and on a desktop the next row of tiles showed behind the buttons, so
 * the screen still read image, card, image. `canvas` was solid and made the viewer
 * a near-white sheet in the light theme, the wrong ground for a picture. Two
 * layers of the one token give a ground that is nearly opaque and the same dark
 * in both themes without a second token; it is also what the caption is read
 * against, and white `on-scrim-media` text holds 4.5:1 over anything under it.
 * The tile's caption bar keeps the single veil, since it sits on a picture.
 *
 * Close is a media control (`MEDIA_CONTROL_CLASS`): white on the veil in both
 * themes, never the theme's `secondary` tile, which turned bright white in the
 * light theme. Download stays the one mango primary. Both draw their focus ring
 * in `on-scrim-media`: the global ring is the theme's `focus`, which in the
 * light theme is a dark brown, and a dark ring on a dark veil is not a ring.
 *
 * Takes the selected item rather than owning it: the gallery grid and the
 * studio's recent strip both open this, and neither should have to reimplement
 * the overlay to do it.
 *
 * It carries the same keyboard contract as the app's other overlays, through
 * the same hook: Escape closes, Tab stays inside, and focus returns to the
 * tile that opened it. Without that, a full-screen overlay is something a
 * keyboard user can neither dismiss nor tab out from behind.
 *
 * // Usage: <GalleryLightbox item={selected} onClose={() => setSelected(null)} />
 */
export function GalleryLightbox({ item, onClose }: GalleryLightboxProps) {
  const { t } = useI18n();
  // Through a ref so the handler's identity never changes: the trap
  // re-registers and re-focuses whenever it does.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const handleEscape = useCallback(() => onCloseRef.current(), []);
  const dialogRef = useFocusTrap(handleEscape);
  const { overlay, dialogPanel } = useMotionPresets();

  return (
    <AnimatePresence>
      {item && (
        <motion.div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={t.gallery.lightboxLabel}
          // The overlay is the dialog rather than the panel inside it, so the
          // close button in the caption row is part of the ring Tab cycles.
          tabIndex={-1}
          {...overlay}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-scrim-media p-4 outline-none md:p-8"
          onClick={onClose}
        >
          {/* The second veil: it paints under the panel and takes no clicks, so
              the backdrop click that closes the viewer reaches the root. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-scrim-media" />
          <motion.div
            {...dialogPanel}
            className="relative flex max-h-full w-full max-w-5xl flex-col items-center"
            onClick={(event) => event.stopPropagation()}
          >
            <img
              src={item.imageUrl}
              alt={item.prompt}
              className="max-h-[75vh] max-w-full rounded-lg object-contain"
              referrerPolicy="no-referrer"
            />
            <div className="mt-4 flex w-full max-w-2xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="min-w-0 text-sm text-on-scrim-media">{item.prompt}</p>
              {/* Close first, the primary last, at natural width: the same footer
                  every dialog in the app ends in. It used to be pinned to the
                  window's corner, on top of the header's account button. */}
              <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                <Button
                  type="button"
                  variant="subtle"
                  size="icon"
                  aria-label={t.gallery.close}
                  title={t.gallery.close}
                  className={MEDIA_CONTROL_CLASS}
                  onClick={onClose}
                >
                  <X size={ICON_MD} />
                </Button>
                <a
                  href={item.imageUrl}
                  download={buildGeneratedImageFilename(t.common.downloadFilenamePrefix, item.id)}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(buttonClassName('primary'), 'focus-visible:outline-on-scrim-media')}
                >
                  <Download size={ICON_MD} />
                  {t.gallery.download}
                </a>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
