/**
 * Migration 002: adds interactionMode to messages and textModel/imageModel/lastUsedMode to chats.
 * Backfills existing chat `model` column into `imageModel` for backward compatibility.
 * Default interactionMode is 'image' so existing messages retain their visual behavior.
 */

import { type Migration } from 'kysely';
import { sql } from 'kysely';

export const addInteractionMode: Migration = {
  async up(db) {
    // Add interactionMode column to messages (default 'image' for existing rows)
    await sql`ALTER TABLE messages ADD COLUMN interactionMode TEXT NOT NULL DEFAULT 'image'`.execute(
      db
    );

    // Add text/image model columns and last used mode to chats
    await sql`ALTER TABLE chats ADD COLUMN textModel TEXT`.execute(db);
    await sql`ALTER TABLE chats ADD COLUMN imageModel TEXT`.execute(db);
    await sql`ALTER TABLE chats ADD COLUMN lastUsedMode TEXT`.execute(db);

    // Backfill: copy existing `model` into `imageModel`
    await sql`UPDATE chats SET imageModel = model WHERE model IS NOT NULL`.execute(db);
  },

  down(_db) {
    // SQLite does not support DROP COLUMN before version 3.35; recreate tables as workaround.
    // For simplicity in development, we skip the full recreation here.
    console.warn(
      '[migrate] 002 down: SQLite does not support DROP COLUMN — manual rollback required.'
    );
    return Promise.resolve();
  },
};
