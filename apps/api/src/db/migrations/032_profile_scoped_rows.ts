import type { Migration } from 'kysely/migration';

/**
 * Migration 032 — reserve a profileId column on profile-scoped tables.
 *
 * Profiles are not implemented yet; every existing and new row uses the
 * literal default `'default'`. The column and rebuilt indexes exist so a
 * later profile feature does not need a unique-constraint migration on
 * populated tables.
 */
export const profileScopedRows: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('environment_install_runs')
      .addColumn('profileId', 'text', (col) => col.notNull().defaultTo('default'))
      .execute();

    await db.schema.dropIndex('idx_environment_install_runs_user_started').ifExists().execute();
    await db.schema
      .createIndex('idx_environment_install_runs_user_profile_started')
      .ifNotExists()
      .on('environment_install_runs')
      .columns(['userId', 'profileId', 'startedAt'])
      .execute();

    await db.schema
      .alterTable('library_divergence_acks')
      .addColumn('profileId', 'text', (col) => col.notNull().defaultTo('default'))
      .execute();

    await db.schema.dropIndex('idx_library_divergence_acks_user_resource').ifExists().execute();
    await db.schema
      .createIndex('idx_library_divergence_acks_user_profile_resource')
      .ifNotExists()
      .on('library_divergence_acks')
      .columns(['userId', 'profileId', 'resourceKey'])
      .unique()
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema
      .dropIndex('idx_library_divergence_acks_user_profile_resource')
      .ifExists()
      .execute();
    await db.schema
      .createIndex('idx_library_divergence_acks_user_resource')
      .ifNotExists()
      .on('library_divergence_acks')
      .columns(['userId', 'resourceKey'])
      .unique()
      .execute();
    await db.schema.alterTable('library_divergence_acks').dropColumn('profileId').execute();

    await db.schema
      .dropIndex('idx_environment_install_runs_user_profile_started')
      .ifExists()
      .execute();
    await db.schema
      .createIndex('idx_environment_install_runs_user_started')
      .ifNotExists()
      .on('environment_install_runs')
      .columns(['userId', 'startedAt'])
      .execute();
    await db.schema.alterTable('environment_install_runs').dropColumn('profileId').execute();
  },
};
