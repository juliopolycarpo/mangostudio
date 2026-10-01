import type { GalleryPage } from '@mangostudio/shared/chat';
import type { GalleryItem } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { listGeneratedImagesForGallery } from '../../generated-images/infrastructure/generated-image-repository';
import {
  compareGalleryOrder,
  decodeGalleryCursor,
  encodeGalleryCursor,
  type GalleryEntry,
} from '../domain/gallery-cursor';
import { listLegacyGalleryImages } from '../infrastructure/message-repository';

export interface ListGalleryInput {
  userId: string;
  /** Opaque `nextCursor` of the previous page; throws `InvalidGalleryCursorError` otherwise. */
  cursor?: string;
  limit?: number;
}

function galleryItemKey(item: GalleryItem): string {
  return `${item.messageId}:${item.imageUrl}`;
}

function toCursorPosition(entry: GalleryEntry<GalleryItem>) {
  return { createdAt: entry.item.createdAt, source: entry.source, rowid: entry.rowid };
}

function compareEntriesDesc(left: GalleryEntry<GalleryItem>, right: GalleryEntry<GalleryItem>) {
  return compareGalleryOrder(toCursorPosition(left), toCursorPosition(right));
}

function dedupeEntries(entries: GalleryEntry<GalleryItem>[]): GalleryEntry<GalleryItem>[] {
  const seen = new Set<string>();
  const deduped: GalleryEntry<GalleryItem>[] = [];

  for (const entry of entries) {
    const key = galleryItemKey(entry.item);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}

/**
 * Pages the global gallery newest first. Generated-image artifacts and legacy
 * image messages are merged under one total order, `createdAt` descending,
 * then source (`artifact` before `message`), then `rowid` descending, because a
 * `rowid` only orders rows of one table. `nextCursor` encodes the last page
 * entry's position in that order; see `gallery-cursor.ts`.
 *
 * @example
 * const page = await listGalleryUseCase({ userId, limit: 20 }, db);
 * const next = await listGalleryUseCase({ userId, limit: 20, cursor: page.nextCursor ?? undefined }, db);
 */
export async function listGalleryUseCase(
  input: ListGalleryInput,
  db: Kysely<Database>
): Promise<GalleryPage> {
  const limit = input.limit ?? 50;
  const cursor = input.cursor ? decodeGalleryCursor(input.cursor) : undefined;
  const [generatedEntries, legacyEntries] = await Promise.all([
    listGeneratedImagesForGallery(input.userId, { cursor, limit }, db),
    listLegacyGalleryImages(input.userId, { cursor, limit }, db),
  ]);

  const entries = dedupeEntries([...generatedEntries, ...legacyEntries].sort(compareEntriesDesc));
  const hasMore = entries.length > limit;
  const pageEntries = entries.slice(0, limit);
  const last = pageEntries.at(-1);

  return {
    items: pageEntries.map((entry) => entry.item),
    nextCursor: hasMore && last ? encodeGalleryCursor(toCursorPosition(last)) : null,
  };
}
