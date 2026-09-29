import type { Migration } from 'kysely/migration';

/**
 * Adds a partial index over the messages still generating.
 *
 * Boot recovery (`reconcileExternalTurns`, then `reconcileStaleTurns`) and the
 * periodic stale-turn sweep all look for `role = 'ai' AND isGenerating = 1`.
 * Without this index SQLite walks every assistant row through the role index,
 * which grows with history while the generating set stays a handful of rows.
 * The index holds only rows with `isGenerating = 1`, so it stays tiny, and
 * only a write that sets `isGenerating` has to maintain it.
 *
 * The predicate must stay a literal: SQLite rejects bound parameters in a
 * partial index `WHERE`, and a query can use the index only when its own
 * `isGenerating = ?` binds the same value.
 */
export const messagesGeneratingIndex: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createIndex('idx_messages_generating')
      .ifNotExists()
      .on('messages')
      .column('isGenerating')
      .where('isGenerating', '=', 1)
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_messages_generating').ifExists().execute();
  },
};
