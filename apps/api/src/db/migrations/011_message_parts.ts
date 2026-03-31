import type { Kysely } from 'kysely';

/**
 * Migration 011 — add parts and providerState columns to messages.
 *
 * Both columns are nullable TEXT. Parts stores JSON-serialized MessagePart[];
 * providerState stores opaque provider continuity blobs (e.g. previous_response_id,
 * thinking signatures).
 */
export const messageParts = {
  async up(db: Kysely<any>): Promise<void> {
    await db.schema
      .alterTable('messages')
      .addColumn('parts', 'text', (col) => col.defaultTo(null))
      .execute();

    await db.schema
      .alterTable('messages')
      .addColumn('providerState', 'text', (col) => col.defaultTo(null))
      .execute();
  },

  async down(_db: Kysely<any>): Promise<void> {
    // SQLite does not support DROP COLUMN before version 3.35.0.
    // Dropping these columns is a no-op; the schema is append-only.
  },
};
