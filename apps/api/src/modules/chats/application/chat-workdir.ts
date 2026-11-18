import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import { type ElysiaStatus, status } from 'elysia';
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
export function chatAccessDenied(resolution: {
  readonly state: 'not-found' | 'forbidden';
}): ElysiaStatus<404, ApiErrorResponse> | ElysiaStatus<403, ApiErrorResponse> {
  if (resolution.state === 'not-found') {
    return status(404, { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND });
  }
  return status(403, { error: 'Chat belongs to another user', code: ERROR_CODES.OWNERSHIP });
}

/** Standard 409 when a route requires a bound chat workdir. */
export function chatWorkdirConflict(): ElysiaStatus<409, ApiErrorResponse> {
  return status(409, { error: 'Chat has no working directory', code: ERROR_CODES.CONFLICT });
}

/** Every refusal the two helpers above can produce, for routes that carry one in a result. */
export type ChatTargetRefusal =
  ReturnType<typeof chatAccessDenied> | ReturnType<typeof chatWorkdirConflict>;
