import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

/** Removes selections saved for nonexistent environments before writes checked ownership. */
export const removeOrphanEnvironmentToolchains: Migration = {
  async up(db): Promise<void> {
    await sql`
      DELETE FROM environment_toolchains
      WHERE environmentId <> 'local'
        AND NOT EXISTS (
          SELECT 1 FROM environments
          WHERE environments.userId = environment_toolchains.userId
            AND environments.id = environment_toolchains.environmentId
        )
    `.execute(db);
  },

  async down(): Promise<void> {
    // Deleted selections cannot be reconstructed.
  },
};
