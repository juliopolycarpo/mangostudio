import type { Migration } from 'kysely/migration';

/**
 * Migration 037 — custom images for tool avatars.
 *
 * Every column is nullable and `imageSource` null is the whole of "this avatar
 * draws its monogram", matching how `displayName` and `monogram` already say
 * "no override". A separate `monogram` marker plus a cached-or-not boolean
 * would give the same state two spellings and let a row claim to be cached with
 * no file behind it; `imagePath` is that answer instead — bytes on disk exist,
 * or they do not.
 *
 * `imagePath` is relative to the configured tool-image directory so moving the
 * directory does not strand every row, and `imageMimeType` is stored beside it
 * because the type served to a browser must be the one validated at write time,
 * never one inferred from the file afterwards.
 */
export const toolIdentityImages: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('user_tool_identities')
      // 'upload' | 'url'; null means no image.
      .addColumn('imageSource', 'text')
      .execute();

    await db.schema
      .alterTable('user_tool_identities')
      // Remote address for an `url` image, kept even when the bytes are cached
      // so the user can see where the image came from.
      .addColumn('imageUrl', 'text')
      .execute();

    await db.schema
      .alterTable('user_tool_identities')
      // Stored bytes, relative to the tool-image directory. Present for every
      // upload and for a URL the user chose to cache.
      .addColumn('imagePath', 'text')
      .execute();

    await db.schema
      .alterTable('user_tool_identities')
      // Pinned at serve time; never re-derived from the stored file.
      .addColumn('imageMimeType', 'text')
      .execute();
  },

  async down(db): Promise<void> {
    for (const column of ['imageMimeType', 'imagePath', 'imageUrl', 'imageSource']) {
      await db.schema.alterTable('user_tool_identities').dropColumn(column).execute();
    }
  },
};
