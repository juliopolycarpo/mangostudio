import type { GalleryItem } from '@mangostudio/shared';
import { client } from '@/lib/api-client';

export async function fetchGalleryItems(): Promise<GalleryItem[]> {
  const { data, error } = await (client as any).api.messages.images.get();
  if (error) throw new Error('Gallery fetch failed');
  return data as GalleryItem[];
}
