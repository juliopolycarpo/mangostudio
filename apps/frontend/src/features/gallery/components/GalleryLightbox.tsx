import type { GalleryItem } from '@mangostudio/shared';
import { Download, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
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
 * // Usage: <GalleryLightbox item={selected} onClose={() => setSelected(null)} />
 */
export function GalleryLightbox({ item, onClose }: GalleryLightboxProps) {
  const { t } = useI18n();

  return (
    <AnimatePresence>
      {item && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-8 bg-black/90 backdrop-blur-sm"
          onClick={onClose}
        >
          <button
            type="button"
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
