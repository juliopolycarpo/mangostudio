/* global fetch */
import type { GalleryItem } from '@mangostudio/shared';

export async function fetchGalleryItems(): Promise<GalleryItem[]> {
  const res = await fetch('/api/messages/images');
  if (!res.ok) {
    throw new Error('Failed to fetch gallery items');
  }
  return res.json();
}
