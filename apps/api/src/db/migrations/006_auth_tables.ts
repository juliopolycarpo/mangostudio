import { type Migration } from 'kysely';

export const authTables: Migration = {
  async up(db) {
    // Tabela de usuários
    await db.schema
      .createTable('user')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('email', 'text', (col) => col.notNull().unique())
      .addColumn('emailVerified', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('image', 'text')
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .execute();

    // Tabela de sessões
    await db.schema
      .createTable('session')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('expiresAt', 'integer', (col) => col.notNull())
      .addColumn('token', 'text', (col) => col.notNull().unique())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .addColumn('ipAddress', 'text')
      .addColumn('userAgent', 'text')
      .addColumn('userId', 'text', (col) => col.notNull().references('user.id').onDelete('cascade'))
      .execute();

    await db.schema.createIndex('session_userId_idx').on('session').column('userId').execute();

    await db.schema.createIndex('session_token_idx').on('session').column('token').execute();

    // Tabela de accounts (providers)
    await db.schema
      .createTable('account')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('accountId', 'text', (col) => col.notNull())
      .addColumn('providerId', 'text', (col) => col.notNull())
      .addColumn('userId', 'text', (col) => col.notNull().references('user.id').onDelete('cascade'))
      .addColumn('accessToken', 'text')
      .addColumn('refreshToken', 'text')
      .addColumn('idToken', 'text')
      .addColumn('accessTokenExpiresAt', 'integer')
      .addColumn('refreshTokenExpiresAt', 'integer')
      .addColumn('scope', 'text')
      .addColumn('password', 'text')
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .execute();

    await db.schema.createIndex('account_userId_idx').on('account').column('userId').execute();

    // Tabela de verificação (tokens de reset, email verification, etc.)
    await db.schema
      .createTable('verification')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('identifier', 'text', (col) => col.notNull())
      .addColumn('value', 'text', (col) => col.notNull())
      .addColumn('expiresAt', 'integer', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('updatedAt', 'integer', (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex('verification_identifier_idx')
      .on('verification')
      .column('identifier')
      .execute();
  },

  async down(db) {
    await db.schema.dropTable('verification').ifExists().execute();
    await db.schema.dropTable('account').ifExists().execute();
    await db.schema.dropTable('session').ifExists().execute();
    await db.schema.dropTable('user').ifExists().execute();
  },
};
