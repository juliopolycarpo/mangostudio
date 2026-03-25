import { LayoutGrid, Download, Maximize2, X, Loader2 } from 'lucide-react';
import type { GalleryItem } from '@mangostudio/shared';
import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useGalleryQuery } from '../hooks/use-gallery-query';
import { useI18n } from '../hooks/use-i18n';

/**
 * Gallery page that displays images from ALL chats (global).
 * Uses TanStack Query for infinite loading.
 */
export function GalleryPage() {
  const [selectedImage, setSelectedImage] = useState<GalleryItem | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    status
  } = useGalleryQuery();

  const items = data?.pages.flatMap((page) => page.items) || [];

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { threshold: 0.1 }
    );

    if (loadMoreRef.current) {
      observer.observe(loadMoreRef.current);
    }

    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div className="p-8 space-y-8 h-full flex flex-col overflow-y-auto">
      <div className="flex items-center gap-4 mb-8 shrink-0">
        <div className="p-3 bg-primary-container text-on-primary-container rounded-2xl">
          <LayoutGrid size={24} />
        </div>
        <h1 className="text-3xl font-bold font-headline text-on-background">{t.gallery.title}</h1>
      </div>

      {status === 'pending' ? (
        <div className="flex justify-center items-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-20 text-on-surface-variant/50 flex-1 flex flex-col items-center justify-center">
          <LayoutGrid size={48} className="mx-auto mb-4 opacity-50" />
          <p className="text-sm font-body">{t.gallery.empty}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 pb-12">
          {items.map((item) => (
            <div
              key={item.id}
              className="group relative aspect-square rounded-2xl overflow-hidden bg-surface-container-high border border-outline-variant/20 shadow-sm hover:shadow-xl transition-all duration-300"
            >
              <img
                src={item.imageUrl}
                alt={item.prompt}
                className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                referrerPolicy="no-referrer"
                loading="lazy"
                decoding="async"
              />

              {/* Overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-4">
                <p className="text-white text-sm line-clamp-3 font-medium mb-3 drop-shadow-md">
                  {item.prompt}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSelectedImage(item)}
                    className="p-2 bg-white/20 hover:bg-white/30 backdrop-blur-md rounded-lg text-white transition-colors flex-1 flex items-center justify-center gap-2"
                  >
                    <Maximize2 size={16} />
                    <span className="text-xs font-bold uppercase tracking-wider">{t.gallery.view}</span>
                  </button>
                  <a
                    href={item.imageUrl}
                    download={`gemini-art-${item.id}.png`}
                    target="_blank"
                    rel="noreferrer"
                    className="p-2 bg-primary hover:bg-primary/90 rounded-lg text-on-primary transition-colors flex items-center justify-center"
                  >
                    <Download size={16} />
                  </a>
                </div>
              </div>
            </div>
          ))}

          <div ref={loadMoreRef} className="col-span-full h-10 flex justify-center items-center">
            {isFetchingNextPage && <Loader2 className="w-6 h-6 animate-spin text-primary" />}
          </div>
        </div>
      )}

      {/* Lightbox */}
      <AnimatePresence>
        {selectedImage && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-8 bg-black/90 backdrop-blur-sm"
            onClick={() => setSelectedImage(null)}
          >
            <button
              className="absolute top-6 right-6 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors"
              onClick={() => setSelectedImage(null)}
            >
              <X size={24} />
            </button>

            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="relative max-w-5xl w-full max-h-full flex flex-col items-center"
              onClick={(e) => e.stopPropagation()}
            >
              <img
                src={selectedImage.imageUrl}
                alt={selectedImage.prompt}
                className="max-w-full max-h-[75vh] object-contain rounded-lg shadow-2xl"
                referrerPolicy="no-referrer"
              />
              <div className="mt-6 p-4 bg-surface-container-highest/80 backdrop-blur-md rounded-xl max-w-2xl w-full text-center border border-outline-variant/20">
                <p className="text-on-surface font-medium">{selectedImage.prompt}</p>
                <a
                  href={selectedImage.imageUrl}
                  download={`gemini-art-${selectedImage.id}.png`}
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
    </div>
  );
}
