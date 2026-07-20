import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { getById } from '../../chats/infrastructure/chat-repository';

export type ChatWorkdirResolution =
  | { readonly state: 'ok'; readonly workdir: string }
  | { readonly state: 'not-found' }
  | { readonly state: 'forbidden' }
  | { readonly state: 'no-workdir' };

/** Resolves the chat-owned workdir without exposing paths across user boundaries. */
export async function resolveChatWorkdir(
  chatId: string,
  userId: string,
  db: Kysely<Database>
): Promise<ChatWorkdirResolution> {
  const chat = await getById(chatId, db);
  if (!chat) return { state: 'not-found' };
  if (chat.userId !== userId) return { state: 'forbidden' };
  if (!chat.workdir) return { state: 'no-workdir' };
  return { state: 'ok', workdir: chat.workdir };
}
