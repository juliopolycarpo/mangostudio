import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { type ChatRecord, getById } from '../infrastructure/chat-repository';

export type ChatWorkdirResolution =
  | { readonly state: 'ok'; readonly workdir: string; readonly chat: ChatRecord }
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
  return { state: 'ok', workdir: chat.workdir, chat };
}

/**
 * Maps a denied resolution onto the shared API error response.
 *
 * Callers keep ownership of `no-workdir`: it is a normal reported state for
 * some endpoints and a conflict for others.
 */
export function chatAccessDenied(
  resolution: { readonly state: 'not-found' | 'forbidden' },
  set: { status?: number | string }
): ApiErrorResponse {
  if (resolution.state === 'not-found') {
    set.status = 404;
    return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
  }
  set.status = 403;
  return { error: 'Chat belongs to another user', code: ERROR_CODES.OWNERSHIP };
}

/** Standard 409 when a route requires a bound chat workdir. */
export function chatWorkdirConflict(set: { status?: number | string }): ApiErrorResponse {
  set.status = 409;
  return { error: 'Chat has no working directory', code: ERROR_CODES.CONFLICT };
}
