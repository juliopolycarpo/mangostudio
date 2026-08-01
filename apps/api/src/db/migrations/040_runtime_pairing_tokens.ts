import type { Migration } from 'kysely/migration';

/**
 * Machine credentials for runtimes that dial the hub instead of being spawned
 * by it. A pairing token belongs to one environment row and dies with it, so
 * the foreign key mirrors the composite `(userId, id)` key `environments`
 * carries and cascades on delete: a socket must never outlive the row that
 * authorized it.
 *
 * `id` is the public selector half of the token and `tokenHash` the SHA-256 of
 * the secret half, so verification is an indexed lookup followed by a
 * constant-time comparison rather than a scan over every stored digest.
 */
export const runtimePairingTokens: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('runtime_pairing_tokens')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('userId', 'text', (col) => col.notNull())
      .addColumn('environmentId', 'text', (col) => col.notNull())
      .addColumn('tokenHash', 'text', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('lastSeenAt', 'integer')
      .addColumn('revokedAt', 'integer')
      .addForeignKeyConstraint(
        'fk_runtime_pairing_tokens_environment',
        ['userId', 'environmentId'],
        'environments',
        ['userId', 'id'],
        (constraint) => constraint.onDelete('cascade')
      )
      .execute();

    await db.schema
      .createIndex('idx_runtime_pairing_tokens_environment')
      .ifNotExists()
      .on('runtime_pairing_tokens')
      .columns(['userId', 'environmentId'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_runtime_pairing_tokens_environment').ifExists().execute();
    await db.schema.dropTable('runtime_pairing_tokens').ifExists().execute();
  },
};
