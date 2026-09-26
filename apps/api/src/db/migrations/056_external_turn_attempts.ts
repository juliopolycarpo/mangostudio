import type { Migration } from 'kysely/migration';

/**
 * Adds `external_turn_attempts`: the hub's receipt for every submission of an
 * external turn to a runtime.
 *
 * One row per attempt, written in state `acceptance-unknown` **before** the
 * `external-agent.turn` request leaves the hub, so a crash, a lost reply or a
 * dropped connection never leaves a submission the hub has no record of. The
 * row is downgraded to `not-submitted` only on proof that nothing reached the
 * runtime, and upgraded to `accepted` — together with the vendor's
 * `nativeTurnId` — in the same write that records the reply.
 *
 * `messageId` is the logical operation (the assistant message the turn
 * fills); several attempts may share it. `inputFingerprint` is a digest of the
 * exact params sent, never the params themselves: they can carry attachment
 * bytes.
 */
export const externalTurnAttempts: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('external_turn_attempts')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('messageId', 'text', (col) => col.notNull())
      .addColumn('chatId', 'text', (col) =>
        col.notNull().references('chats.id').onDelete('cascade')
      )
      .addColumn('userId', 'text', (col) => col.notNull())
      .addColumn('environmentId', 'text', (col) => col.notNull())
      .addColumn('sessionId', 'text', (col) => col.notNull())
      .addColumn('clientMessageId', 'text', (col) => col.notNull())
      .addColumn('inputFingerprint', 'text', (col) => col.notNull())
      .addColumn('state', 'text', (col) => col.notNull())
      .addColumn('nativeTurnId', 'text')
      .addColumn('terminalReason', 'text')
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .execute();
    await db.schema
      .createIndex('external_turn_attempts_message')
      .ifNotExists()
      .on('external_turn_attempts')
      .column('messageId')
      .execute();
    await db.schema
      // Chat deletion cascades here; without this SQLite scans the table.
      .createIndex('external_turn_attempts_chat')
      .ifNotExists()
      .on('external_turn_attempts')
      .column('chatId')
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropTable('external_turn_attempts').ifExists().execute();
  },
};
