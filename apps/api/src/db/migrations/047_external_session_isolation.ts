import type { Migration } from 'kysely/migration';

/**
 * The credential home a continuation was opened against.
 *
 * `vendorAccountFingerprint` already covers "the vendor account changed". This
 * covers the level below it: the *machine identity* the vendor reads its
 * credentials from. The two are not the same event, and only one of them is
 * visible to a status call — a remote account re-pointed at a different OS home,
 * a container recreated with a fresh volume, or an SSH environment repointed at
 * another host all keep the vendor account looking identical while the
 * conversation being resumed no longer belongs to the identity that made it.
 *
 * Nullable, because attestation is optional by contract and rows written before
 * this column existed have nothing to backfill from. A null reads as "not
 * established" at the comparison, which starts a fresh session rather than
 * resuming one whose provenance cannot be checked.
 */
export const externalSessionIsolation: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('external_session_continuations')
      .addColumn('credentialHomeFingerprint', 'text')
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema
      .alterTable('external_session_continuations')
      .dropColumn('credentialHomeFingerprint')
      .execute();
  },
};
