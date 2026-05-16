import type { GalleryItem } from '@mangostudio/shared';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { listGeneratedImagesForGallery } from '../../generated-images/infrastructure/generated-image-repository';
import { listLegacyGalleryImages } from '../infrastructure/message-repository';

export interface ListGalleryInput {
  userId: string;
  cursor?: number;
  limit?: number;
}

function galleryItemKey(item: GalleryItem): string {
  return `${item.messageId}:${item.imageUrl}`;
}

function compareGalleryItemsDesc(left: GalleryItem, right: GalleryItem): number {
  if (left.createdAt !== right.createdAt) {
    return right.createdAt - left.createdAt;
  }

  return right.id.localeCompare(left.id);
}

function dedupeGalleryItems(items: GalleryItem[]): GalleryItem[] {
  const seen = new Set<string>();
  const deduped: GalleryItem[] = [];

  for (const item of items) {
    const key = galleryItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

export async function listGalleryUseCase(input: ListGalleryInput, db: Kysely<Database>) {
  const limit = input.limit ?? 50;
  const [generatedItems, legacyItems] = await Promise.all([
    listGeneratedImagesForGallery(input.userId, { cursor: input.cursor, limit }, db),
    listLegacyGalleryImages(input.userId, { cursor: input.cursor, limit }, db),
  ]);

  const items = dedupeGalleryItems(
    [...generatedItems, ...legacyItems].sort(compareGalleryItemsDesc)
  );
  const hasMore = items.length > limit;
  const pageItems = items.slice(0, limit);

  return {
    items: pageItems,
    nextCursor: hasMore && pageItems.length > 0 ? String(pageItems.at(-1)?.createdAt) : null,
  };
}
