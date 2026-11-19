import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Indexes `file_checkpoints.blobKey` so the "does any row still use this blob"
 * check is a seek. `releaseCheckpointBlobs` asks it once per blob key, on a chat
 * delete and when retention trims a chat, and with no index each ask scanned
 * the whole table: 4.7 ms at 50k rows, against 5 microseconds with the index.
 *
 * Partial, because the lookup is an equality on a non-null key and a row for a
 * file that did not exist before the call, or whose before-image was omitted,
 * carries no blob, so it needs no entry.
 */
export const fileCheckpointBlobKeyIndex: Migration = {
  async up(db): Promise<void> {
    // The builder has no partial-index predicate on a column that is not part of the key.
    await sql`CREATE INDEX IF NOT EXISTS idx_file_checkpoints_blob_key ON file_checkpoints (blobKey) WHERE blobKey IS NOT NULL`.execute(
      db
    );
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_file_checkpoints_blob_key').ifExists().execute();
  },
};
