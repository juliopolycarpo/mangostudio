import Type, { type Static } from 'typebox';
import type { GalleryItem } from '../types/gallery';

/** Query of `GET /api/messages/images`. */
export const ListGalleryQuerySchema = Type.Object({
  limit: Type.Optional(Type.String()),
  /**
   * The `nextCursor` of the previous page, passed back unchanged. The value is
   * opaque: it encodes the position of the last image returned. A bare
   * timestamp from an older server is still read as a best-effort position;
   * any other value that is not a cursor this server issued is rejected with a 400.
   */
  cursor: Type.Optional(Type.String()),
});

export type ListGalleryQuery = Static<typeof ListGalleryQuerySchema>;

/**
 * One page of the global gallery, newest image first.
 *
 * `nextCursor` is `null` on the last page; otherwise it is an opaque token to
 * send back as `cursor`.
 *
 * The item type is `GalleryItem` (a `GeneratedImageArtifact`), but the items
 * stay declared as open objects here on purpose: the two sources of a page
 * build their items with different key orders, and a closed schema serialises
 * in its own key order, so describing them would change the bytes of every
 * legacy item.
 */
export const GalleryPageSchema = Type.Object({
  items: Type.Array(Type.Unsafe<GalleryItem>(Type.Object({}, { additionalProperties: true }))),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

export type GalleryPage = Static<typeof GalleryPageSchema>;
