import type { GalleryItem } from '@mangostudio/shared/types';
import { Download, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { useI18n } from '@/hooks/use-i18n';
import { buildGeneratedImageFilename } from '@/lib/download-filenames';
import { ICON_MD } from '@/lib/icon-sizes';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';

interface GalleryLightboxProps {
  /** The image on screen, or null for "closed" — the exit animation needs both. */
  readonly item: GalleryItem | null;
  readonly onClose: () => void;
}

/**
 * The full image over the scrim, with its prompt and a download link.
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
          // close button in its corner is part of the ring Tab cycles.
          tabIndex={-1}
          {...overlay}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-scrim p-4 outline-none md:p-8"
          onClick={onClose}
        >
          <Button
            type="button"
            variant="secondary"
            size="icon"
            aria-label={t.gallery.close}
            className="absolute top-4 right-4"
            onClick={onClose}
          >
            <X size={ICON_MD} />
          </Button>

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
            <div className="mt-4 flex w-full max-w-2xl flex-col gap-4 rounded-md border border-stroke bg-surface-raised p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="min-w-0 text-sm text-fg">{item.prompt}</p>
              <a
                href={item.imageUrl}
                download={buildGeneratedImageFilename(t.common.downloadFilenamePrefix, item.id)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 shrink-0 items-center justify-center gap-2 self-start rounded-sm bg-accent px-3 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover active:bg-accent-pressed sm:self-auto"
              >
                <Download size={ICON_MD} />
                {t.gallery.download}
              </a>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
