import type { Migration } from 'kysely/migration';

/**
 * Server-owned continuation state for external-agent chats. Never referenced
 * from `apps/shared/src/chat/` — a chat's runner configuration is user-set,
 * but which vendor session it resumes is not, so the two stay in separate
 * tables with separate write paths.
 */
export const externalSessionContinuations: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('external_session_continuations')
      .ifNotExists()
      .addColumn('chatId', 'text', (col) =>
        col.primaryKey().references('chats.id').onDelete('cascade')
      )
      .addColumn('userId', 'text', (col) => col.notNull())
      .addColumn('environmentId', 'text', (col) => col.notNull())
      .addColumn('targetId', 'text', (col) => col.notNull())
      .addColumn('canonicalWorkspacePath', 'text', (col) => col.notNull())
      .addColumn('vendorAccountFingerprint', 'text')
      .addColumn('runtimeSessionId', 'text', (col) => col.notNull())
      .addColumn('nativeSessionId', 'text', (col) => col.notNull())
      .addColumn('effectiveConfiguration', 'text')
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropTable('external_session_continuations').ifExists().execute();
  },
};
