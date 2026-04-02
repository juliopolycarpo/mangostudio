import type { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('chats').addColumn('lastProviderState', 'text').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('chats').dropColumn('lastProviderState').execute();
}

export const chatProviderState = { up, down };
