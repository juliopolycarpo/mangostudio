import { parseCursorPosition } from './cursor-position';

/**
 * Where a gallery image is stored. The gallery merges two tables, and a
 * SQLite `rowid` only orders rows of one table, so the source is part of the
 * paging order.
 *
 * - `artifact`: a row of `generated_images`.
 * - `message`: a legacy `ai` message carrying `imageUrl` with no artifact row.
 */
export type GallerySource = 'artifact' | 'message';

/** Rank within a shared timestamp: artifacts come before legacy messages. */
const SOURCE_RANK: Record<GallerySource, number> = { artifact: 0, message: 1 };

/**
 * Position of one gallery image in the order the gallery is paged:
 * `createdAt` descending, then source (`artifact` before `message`), then
 * `rowid` descending (newest insert first) within one source.
 */
export interface GalleryCursor {
  createdAt: number;
  source: GallerySource;
  rowid: number;
}

/** One gallery row as a repository returns it: the item plus where it sorts. */
export interface GalleryEntry<Item> {
  item: Item;
  source: GallerySource;
  rowid: number;
}

export const GALLERY_CURSOR_SHAPE = '<artifact|message>:<createdAt>:<rowid>';

const SOURCE_PREFIX = /^(artifact|message):(.*)$/;

/** Raised when a client sends a cursor this server did not issue. */
export class InvalidGalleryCursorError extends Error {
  constructor(value: string) {
    super(
      `Invalid gallery cursor: ${JSON.stringify(value)} | expected shape: ${GALLERY_CURSOR_SHAPE}`
    );
    this.name = 'InvalidGalleryCursorError';
  }
}

/**
 * Encodes a cursor as the opaque string a client sends back unchanged.
 *
 * @example
 * encodeGalleryCursor({ createdAt: 1700000000000, source: 'artifact', rowid: 42 });
 * // 'artifact:1700000000000:42'
 */
export function encodeGalleryCursor(cursor: GalleryCursor): string {
  return `${cursor.source}:${cursor.createdAt}:${cursor.rowid}`;
}

/**
 * Decodes a cursor produced by {@link encodeGalleryCursor}.
 *
 * A bare numeric timestamp (the format servers issued before the cursor
 * carried a source and rowid) is still accepted, best effort. The gallery pages
 * newest first with `<`, so it is read as the position *after* every image of
 * that timestamp (last source, rowid `0`): images tied with the last one
 * returned may be skipped, but none are repeated, which is exactly what the old
 * `createdAt < cursor` filter did. Anything else throws.
 *
 * @example
 * decodeGalleryCursor('artifact:1700000000000:42');
 * // { createdAt: 1700000000000, source: 'artifact', rowid: 42 }
 * decodeGalleryCursor('1700000000000'); // { createdAt: 1700000000000, source: 'message', rowid: 0 }
 * decodeGalleryCursor('abc'); // throws InvalidGalleryCursorError
 */
export function decodeGalleryCursor(value: string): GalleryCursor {
  const prefixed = SOURCE_PREFIX.exec(value);
  const position = parseCursorPosition(prefixed ? (prefixed[2] ?? '') : value);
  if (!position) throw new InvalidGalleryCursorError(value);

  if (!prefixed) {
    if (position.rowid !== null) throw new InvalidGalleryCursorError(value);
    return { createdAt: position.timestamp, source: 'message', rowid: 0 };
  }

  if (position.rowid === null) throw new InvalidGalleryCursorError(value);
  return {
    createdAt: position.timestamp,
    source: prefixed[1] as GallerySource,
    rowid: position.rowid,
  };
}

/**
 * Total order of the merged gallery, newest first. The use case sorts with it
 * and each repository query filters and orders to match it, so the last row of
 * a page is the true boundary of the next one.
 */
export function compareGalleryOrder(left: GalleryCursor, right: GalleryCursor): number {
  if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt;
  if (left.source !== right.source) return SOURCE_RANK[left.source] - SOURCE_RANK[right.source];
  return right.rowid - left.rowid;
}

/**
 * The exclusive `rowid` ceiling for one source's rows tied with the cursor's
 * `createdAt`: such a row comes after the cursor when its `rowid` is below it.
 * Rows with an earlier `createdAt` always come after the cursor.
 *
 * Use it as `(createdAt, rowid) < (cursor.createdAt, tiedRowidCeiling(...))`.
 *
 * @example
 * const cursor = { createdAt: 5, source: 'artifact', rowid: 9 } as const;
 * tiedRowidCeiling('artifact', cursor); // 9: artifact rows tied at 5 with rowid < 9
 * tiedRowidCeiling('message', cursor); // Number.MAX_SAFE_INTEGER: every message tied at 5
 */
export function tiedRowidCeiling(source: GallerySource, cursor: GalleryCursor): number {
  const own = SOURCE_RANK[source];
  const boundary = SOURCE_RANK[cursor.source];
  if (own < boundary) return 0;
  if (own > boundary) return Number.MAX_SAFE_INTEGER;
  return cursor.rowid;
}
