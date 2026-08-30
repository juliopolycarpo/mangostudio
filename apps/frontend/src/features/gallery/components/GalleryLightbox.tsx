import type { GalleryItem } from '@mangostudio/shared';
import { Download, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useRef } from 'react';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { useI18n } from '@/hooks/use-i18n';
import { buildGeneratedImageFilename } from '@/lib/download-filenames';

interface GalleryLightboxProps {
  /** The image on screen, or null for "closed" — the exit animation needs both. */
  readonly item: GalleryItem | null;
  readonly onClose: () => void;
}

/**
 * The full image over a dimmed page, with its prompt and a download link.
 *
 * Takes the selected item rather than owning it: the gallery grid and the
 * studio's recent strip both open this, and neither should have to reimplement
 * the overlay to do it.
 *
 * It carries the same keyboard contract as the app's other overlays, through
 * the same hook: Escape closes, Tab stays inside, and focus returns to the
 * tile that opened it. Without that, a full-screen black overlay is something
 * a keyboard user can neither dismiss nor tab out from behind.
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

  return (
    <AnimatePresence>
      {item && (
        <motion.div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={t.gallery.lightboxLabel}
          // The overlay is the dialog rather than the panel inside it, so the
          // close button in its corner is part of the ring Tab cycles.
          tabIndex={-1}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-8 bg-black/90 backdrop-blur-sm outline-none"
          onClick={onClose}
        >
          <button
            type="button"
            aria-label={t.gallery.close}
            className="absolute top-6 right-6 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors"
            onClick={onClose}
          >
            <X size={24} />
          </button>

          <motion.div
            initial={{ scale: 0.9, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.9, y: 20 }}
            className="relative max-w-5xl w-full max-h-full flex flex-col items-center"
            onClick={(event) => event.stopPropagation()}
          >
            <img
              src={item.imageUrl}
              alt={item.prompt}
              className="max-w-full max-h-[75vh] object-contain rounded-lg shadow-2xl"
              referrerPolicy="no-referrer"
            />
            <div className="mt-6 p-4 bg-surface-container-highest/80 backdrop-blur-md rounded-xl max-w-2xl w-full text-center border border-outline-variant/20">
              <p className="text-on-surface font-medium">{item.prompt}</p>
              <a
                href={item.imageUrl}
                download={buildGeneratedImageFilename(t.common.downloadFilenamePrefix, item.id)}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-primary text-on-primary rounded-full text-sm font-bold hover:bg-primary/90 transition-colors"
              >
                <Download size={16} />
                {t.gallery.download}
              </a>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
