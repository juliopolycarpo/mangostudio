/* global console */
import { useState, useCallback } from 'react';
import type { GalleryItem } from '@mangostudio/shared';
import { fetchGalleryItems as fetchGalleryItemsApi } from '../services/gallery-service';
import { useI18n } from './use-i18n';

export function useGallery() {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();

  const loadItems = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchGalleryItemsApi();
      setItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errors.galleryLoadFailed);
      console.error('Failed to fetch gallery items', err);
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  const clearItems = useCallback(() => {
    setItems([]);
  }, []);

  return {
    items,
    isLoading,
    error,
    loadItems,
    clearItems,
    setItems,
  };
}
