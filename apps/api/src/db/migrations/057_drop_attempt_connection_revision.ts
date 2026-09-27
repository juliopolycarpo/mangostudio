import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Drops `external_turn_attempts.connectionRevision` from a database that ran
 * an earlier draft of migration 056. The column held a per-process counter
 * that restarted with the hub, so it never identified a connection, and
 * nothing read it. The current 056 no longer creates it; a database that
 * already has it would refuse every new receipt, since the column is NOT NULL
 * and the hub no longer writes it.
 */
export const dropAttemptConnectionRevision: Migration = {
  async up(db): Promise<void> {
    const columns = await sql<{
      name: string;
    }>`SELECT name FROM pragma_table_info('external_turn_attempts')`.execute(db);
    if (!columns.rows.some((column) => column.name === 'connectionRevision')) return;
    await db.schema.alterTable('external_turn_attempts').dropColumn('connectionRevision').execute();
  },

  async down(): Promise<void> {
    // No-op: the dropped counter meant nothing outside the process that wrote it.
  },
};
