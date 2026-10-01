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
 * The item shape stays the hand-written `GalleryItem` interface: it has no
 * schema yet, so each item is declared as an open object here instead of
 * being re-described.
 */
export const GalleryPageSchema = Type.Object({
  items: Type.Array(Type.Unsafe<GalleryItem>(Type.Object({}, { additionalProperties: true }))),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

export type GalleryPage = Static<typeof GalleryPageSchema>;
