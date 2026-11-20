import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Creates the reserved owner for operations that run before any account exists.
 *
 * `env install` from a terminal on a hub nobody has signed in to recorded its
 * audit row under the literal user id `local`, but `environment_install_runs.userId`
 * has a foreign key to `user.id`, so the insert failed before the installer ran.
 * Rather than drop the accountless path, give it a real row.
 *
 * The row cannot sign in: there is no `account` row, so no credential exists to
 * check, and its email is on the reserved `.invalid` TLD, so nothing can be
 * mailed to it. The email column is unique, which also stops anyone registering
 * it. The literals are frozen here on purpose; a migration must not change when
 * an application constant does.
 */
export const systemInstallOwner: Migration = {
  async up(db): Promise<void> {
    const now = new Date().toISOString();
    await sql`
      INSERT OR IGNORE INTO user (id, name, email, emailVerified, image, createdAt, updatedAt)
      VALUES ('local', 'MangoStudio system', 'system@mangostudio.invalid', 0, NULL, ${now}, ${now})
    `.execute(db);
  },

  async down(db): Promise<void> {
    // Cascades to anything recorded under it, as deleting any other user does.
    await sql`DELETE FROM user WHERE id = 'local' AND email = 'system@mangostudio.invalid'`.execute(
      db
    );
  },
};
