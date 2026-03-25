import { type Migration } from 'kysely';

export const addUserOwnership: Migration = {
  async up(db) {
    // Adicionar userId às tabelas existentes
    await db.schema
      .alterTable('chats')
      .addColumn('userId', 'text', (col) => col.references('user.id').onDelete('cascade'))
      .execute();

    await db.schema.createIndex('chats_userId_idx').on('chats').column('userId').execute();

    // secret_metadata também precisa de userId
    // (cada usuário gerencia seus próprios connectors)
    await db.schema
      .alterTable('secret_metadata')
      .addColumn('userId', 'text', (col) => col.references('user.id').onDelete('cascade'))
      .execute();

    await db.schema
      .createIndex('secret_metadata_userId_idx')
      .on('secret_metadata')
      .column('userId')
      .execute();
  },

  async down(db) {
    // SQLite não suporta DROP COLUMN antes do 3.35.0,
    // mas Bun's SQLite é recente o suficiente
    await db.schema.alterTable('chats').dropColumn('userId').execute();
    await db.schema.alterTable('secret_metadata').dropColumn('userId').execute();
  },
};
