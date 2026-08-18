import type { Migration } from 'kysely/migration';

/**
 * The directory manifest format changed (length-prefixed entries, a bumped
 * `DIRECTORY_HASH_DOMAIN`), so every stored directory content hash changes
 * with it. A row in `library_divergence_acks` is keyed by the exact hash set a
 * user accepted; left alone, every directory-backed resource would surface as
 * a fresh, unexplained divergence the next time its acknowledgement silently
 * stops matching. Clearing the table is the deliberate version of that same
 * outcome: a resource a user had accepted needs re-acknowledging once, instead
 * of the mismatch being discovered as unexplained mass divergence.
 */
export const clearStaleDivergenceAcks: Migration = {
  async up(db): Promise<void> {
    await db.deleteFrom('library_divergence_acks').execute();
  },

  async down(): Promise<void> {
    // No-op: the deleted acknowledgements cannot be reconstructed.
  },
};
