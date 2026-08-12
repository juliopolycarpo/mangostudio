import type { Migration } from 'kysely/migration';

/**
 * Discardable cache of vendor account rate-limit snapshots.
 *
 * Not a domain table: the selector shows quota before a turn starts, and the
 * rows are safe to drop. The primary key is the full cache key
 * `(userId, environmentId, targetId, vendorAccountFingerprint)` — two
 * environments or two vendor accounts must never share a snapshot.
 *
 * `limitsJson` holds an `ExternalAccountLimits` payload; `observedAtMs` is
 * denormalized beside it so freshness checks do not require parsing JSON.
 */
export const externalAccountLimitsCache: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('external_account_limits_cache')
      .ifNotExists()
      .addColumn('userId', 'text', (col) => col.notNull())
      .addColumn('environmentId', 'text', (col) => col.notNull())
      .addColumn('targetId', 'text', (col) => col.notNull())
      /** Empty string when the adapter reported no account fingerprint. */
      .addColumn('vendorAccountFingerprint', 'text', (col) => col.notNull())
      .addColumn('limitsJson', 'text', (col) => col.notNull())
      .addColumn('observedAtMs', 'integer', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .addPrimaryKeyConstraint('external_account_limits_cache_pk', [
        'userId',
        'environmentId',
        'targetId',
        'vendorAccountFingerprint',
      ])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropTable('external_account_limits_cache').ifExists().execute();
  },
};
