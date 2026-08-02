import type { Migration } from 'kysely/migration';

/**
 * Per-environment opt-in for running install recipes on that machine.
 *
 * A column rather than a field in the transport config, because it is not
 * addressing: it is the hub's policy about a machine, and it has to answer the
 * same way whether the environment is reached over ssh, a socket, or a
 * subprocess. It defaults to off — the guard that already protects the hub's
 * own machine has no equivalent for someone else's, and inheriting "allowed"
 * from a loopback check performed here would be exactly the wrong reading.
 */
export const environmentAllowInstalls: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('environments')
      .addColumn('allowInstalls', 'integer', (col) => col.notNull().defaultTo(0))
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.alterTable('environments').dropColumn('allowInstalls').execute();
  },
};
