/* global console */
import { useState, useCallback } from 'react';
import type { GalleryItem } from '@mangostudio/shared';
import { fetchGalleryItems as fetchGalleryItemsApi } from '../services/gallery-service';

export function useGallery() {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchGalleryItemsApi();
      setItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load gallery items');
      console.error('Failed to fetch gallery items', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

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
