import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export const userPreferences = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('user_preferences')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('userId', 'text', (col) => col.notNull().references('user.id').onDelete('cascade'))
      .addColumn('key', 'text', (col) => col.notNull())
      .addColumn('value', 'text', (col) => col.notNull())
      .addColumn('updatedAt', 'text', (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
      .addUniqueConstraint('uq_user_preferences_userId_key', ['userId', 'key'])
      .execute();

    await db.schema
      .createIndex('idx_user_preferences_userId')
      .on('user_preferences')
      .column('userId')
      .execute();
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('user_preferences').execute();
  },
};
