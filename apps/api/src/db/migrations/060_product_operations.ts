import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const productOperations: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('product_operations')
      .ifNotExists()
      .addColumn('userId', 'text', (col) => col.notNull().references('user.id').onDelete('cascade'))
      .addColumn('operationId', 'text', (col) => col.notNull())
      .addColumn('kind', 'text', (col) => col.notNull())
      .addColumn('fingerprint', 'text', (col) => col.notNull())
      .addColumn('owner', 'text', (col) => col.notNull())
      .addColumn('state', 'text', (col) => col.notNull())
      .addColumn('chatId', 'text')
      .addColumn('messageId', 'text')
      .addColumn('result', 'text')
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('expiresAt', 'integer', (col) => col.notNull())
      .addPrimaryKeyConstraint('product_operations_pk', ['userId', 'operationId'])
      .execute();
    await db.schema
      .createIndex('idx_product_operations_expiresAt')
      .ifNotExists()
      .on('product_operations')
      .column('expiresAt')
      .where(sql.ref('result'), 'is not', null)
      .execute();
  },
  async down(db): Promise<void> {
    await db.schema.dropTable('product_operations').ifExists().execute();
  },
};
